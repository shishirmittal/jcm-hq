// jcm-sync.js — JCM Sync: one program that runs every Busy → Supabase job on JCM-Server.
//
// Replaces the separate Task Scheduler tasks (one per script) with ONE task that starts
// this at boot (run-jcm-sync.bat keeps it running). The scripts themselves are unchanged:
// JCM Sync only starts them, each as its own process, on its own timetable (JOBS below).
//
//  - A job never runs twice at the same time; one that hangs is stopped after its time limit.
//  - One job failing never stops the others.
//  - Every run is recorded in Supabase (JCM-Busysql project: sync_jobs, sync_job_runs) for
//    the Sync status page in JCM HQ (hq.jcmretails.com/#sync-status), which also has a
//    "Run now" button per job.
//  - A file named jcm-sync.pause in this folder pauses everything (delete it to resume).
//  - A file named jcm-sync.restart makes it exit once nothing is running; the .bat starts it again
//    with the current jcm-sync.js (use after updating the JOBS list).
//  - The nightly sync runs at its time; if the PC was off then, it runs at the next start.
//
//   node jcm-sync.js            run (normally started by run-jcm-sync.bat)
//   node jcm-sync.js --list     show the timetable and exit
//   node jcm-sync.js --once ID  run one job now, wait for it, record it, exit
//
// Lives in D:\JCM-Supabase\files beside the scripts it runs; uses the same .env
// (SUPABASE_URL, SUPABASE_SERVICE_KEY = JCM-Busysql project) and node_modules.
// Writes jcm-sync.log in the same folder. Needs supabase/jcm-sync-setup.sql run once.

require('dotenv').config();
const { spawn } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;

// ---------------------------------------------------------------------------
// The timetable. every = minutes between starts; dailyAt = 'HH:MM' India time;
// hours = only start between these India times; timeout = minutes before a run is stopped;
// args = what follows `node`; logFile = where the script's own output goes (for scripts
// that do not keep a log of their own).
// ---------------------------------------------------------------------------
const JOBS = [
  { id: 'orders', name: 'Orders (board, tablet, Orders tab)', args: ['sync-orders.js'], every: 3, timeout: 10 },
  { id: 'stock', name: 'Stock (live)', args: ['sync-stock-live.js'], every: 10, timeout: 9, hours: ['09:00', '21:00'] },
  { id: 'red-alerts', name: 'Red Alerts', args: ['sync-red-alerts.js'], every: 15, timeout: 14 },
  { id: 'purchases', name: 'Purchase Summary (+ WhatsApps)', args: ['sync-purchases.js'], every: 15, timeout: 14 },
  { id: 'dues', name: 'Dues (Payment Follow-up)', args: ['-r', './dues-env.js', 'sync-dues-final.js'], every: 30, timeout: 25, logFile: 'dues.log' },
  { id: 'ledger', name: 'Customer ledger', args: ['sync-ledger.js'], every: 30, timeout: 25 },
  // Payment Follow-up: 10:00 WhatsApp + Task Board task per person, 19:00 summary to admins.
  // HQ decides what is due; this only asks every 15 minutes (see followup-notify.js).
  { id: 'followup-notify', name: 'Payment follow-up WhatsApps + tasks', args: ['followup-notify.js'], every: 15, timeout: 5 },
  // GSTR-2A reconciliation: 2A data Busy downloaded + purchase GST summaries + party contacts.
  { id: 'gst', name: 'GSTR-2A reconciliation data', args: ['sync-gst.js'], every: 30, timeout: 15 },
  // Customer / supplier WhatsApps for new Busy vouchers (invoices at 20:30, the rest at once) — see sync-transactions.js.
  { id: 'transactions', name: 'Transaction WhatsApps (invoice, receipt, notes, order…)', args: ['sync-transactions.js'], every: 5, timeout: 4 },
  { id: 'nightly', name: 'Nightly full sync (items, sales, invoices, customers)', args: ['sync.js'], dailyAt: '22:54', timeout: 120, logFile: 'task-scheduler.log' },
];

const TICK_MS = 15 * 1000;
const STAGGER_MS = 20 * 1000;        // jobs due together start this far apart
const KEEP_RUNS_DAYS = 14;
const LOG_FILE = path.join(DIR, 'jcm-sync.log');
const LOCK_FILE = path.join(DIR, 'jcm-sync.lock');
const PAUSE_FILE = path.join(DIR, 'jcm-sync.pause');
const RESTART_FILE = path.join(DIR, 'jcm-sync.restart'); // create this file → the runner exits and run-jcm-sync.bat starts it again (picks up new jobs)

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) { /* logging must never stop the runner */ }
}

// India time helpers (the PC may be on any time zone setting).
const istParts = (d = new Date()) => {
  const t = new Date(+d + 5.5 * 3600e3);
  return { date: t.toISOString().slice(0, 10), mins: t.getUTCHours() * 60 + t.getUTCMinutes() };
};
const toMins = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const describe = j => j.dailyAt ? `daily at ${j.dailyAt}` : `every ${j.every} min${j.hours ? ` (${j.hours[0]}–${j.hours[1]})` : ''}`;

// ---------------------------------------------------------------------------
// Supabase (status for the HQ page). Never allowed to stop a job from running.
// ---------------------------------------------------------------------------
const db = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;
let dbWarned = false;
async function safe(what, fn) {
  if (!db) return null;
  try {
    const r = await fn();
    if (r && r.error) throw new Error(r.error.message);
    return r ? r.data : null;
  } catch (err) {
    if (!dbWarned) log(`status not saved (${what}): ${err.message} — is supabase/jcm-sync-setup.sql run?`);
    dbWarned = true;
    return null;
  }
}

// ---------------------------------------------------------------------------
// State per job
// ---------------------------------------------------------------------------
const state = Object.fromEntries(JOBS.map(j => [j.id, { running: null, lastStart: 0, lastDailyDate: null, requestedSeen: null }]));

async function loadState() {
  const rows = await safe('read', () => db.from('sync_jobs').select('*'));
  for (const r of rows || []) {
    const s = state[r.job_id];
    if (!s) continue;
    if (r.last_started_at) s.lastStart = Date.parse(r.last_started_at);
    s.requestedSeen = r.run_requested_at || null;
    const job = JOBS.find(j => j.id === r.job_id);
    // A daily job that already ran today (India date) after its time is done for today.
    if (job.dailyAt && r.last_started_at) {
      const p = istParts(new Date(r.last_started_at));
      if (p.mins >= toMins(job.dailyAt)) s.lastDailyDate = p.date;
    }
  }
}

async function publishTimetable() {
  const now = new Date().toISOString();
  await safe('timetable', () => db.from('sync_jobs').upsert(JOBS.map((j, i) => ({
    job_id: j.id, name: j.name, schedule: describe(j), sort_order: i,
    every_minutes: j.every || null, daily_at: j.dailyAt || null, runner_seen_at: now,
  })), { onConflict: 'job_id' }));
}

// ---------------------------------------------------------------------------
// Running one job
// ---------------------------------------------------------------------------
function runJob(job, why) {
  const s = state[job.id];
  if (s.running) return s.running;
  const started = new Date();
  s.lastStart = started.getTime();
  // Only the run at its own time counts as "tonight's"; a catch-up or Run now in the
  // morning must not stop the evening run.
  if (job.dailyAt && why === 'daily time') s.lastDailyDate = istParts(started).date;
  log(`▶ ${job.id} started (${why})`);

  const out = [];
  let logStream = null;
  if (job.logFile) {
    try {
      logStream = fs.createWriteStream(path.join(DIR, job.logFile), { flags: 'a' });
      logStream.write(`\n=== ${job.name} — started by JCM Sync at ${started.toISOString()} (${why}) ===\n`);
    } catch (_) { logStream = null; }
  }
  const keep = chunk => {
    const text = chunk.toString();
    if (logStream) logStream.write(text);
    for (const l of text.split(/\r?\n/)) if (l.trim()) { out.push(l.trim()); if (out.length > 40) out.shift(); }
  };

  safe('start', () => db.from('sync_jobs').update({ last_started_at: started.toISOString(), running: true }).eq('job_id', job.id));

  s.running = new Promise(resolve => {
    let child;
    try {
      child = spawn(process.execPath, job.args, { cwd: DIR, windowsHide: true, env: process.env });
    } catch (err) {
      return resolve({ code: -1, error: err.message });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`■ ${job.id} took longer than ${job.timeout} min — stopping it`);
      try { child.kill(); } catch (_) { /* already gone */ }
    }, job.timeout * 60e3);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', err => { clearTimeout(timer); resolve({ code: -1, error: err.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: timedOut ? -2 : code }); });
  }).then(async ({ code, error }) => {
    const finished = new Date();
    const ok = code === 0;
    const tail = out.slice(-1)[0] || '';
    let message = error ? `could not start: ${error}`
      : code === -2 ? `stopped after ${job.timeout} min (took too long)`
      : (ok ? tail : (out.filter(l => /error|fail/i.test(l)).slice(-1)[0] || tail || `exit code ${code}`));
    message = message.replace(/^\[\d{4}-\d\d-\d\dT[^\]]+\]\s*/, '').slice(0, 500);
    const ms = finished - started;
    log(`${ok ? '✔' : '✖'} ${job.id} ${ok ? 'done' : 'FAILED'} in ${Math.round(ms / 1000)} s — ${message}`);
    if (logStream) { logStream.write(`=== finished: ${ok ? 'ok' : 'FAILED'} (exit ${code}) ===\n`); logStream.end(); }
    await safe('finish', () => db.from('sync_jobs').update({
      running: false, last_finished_at: finished.toISOString(), last_ok: ok, last_exit: code,
      last_message: message, last_duration_ms: ms, ...(ok ? { last_ok_at: finished.toISOString() } : {}),
    }).eq('job_id', job.id));
    await safe('history', () => db.from('sync_job_runs').insert({
      job_id: job.id, started_at: started.toISOString(), finished_at: finished.toISOString(),
      ok, exit_code: code, message, reason: why, output: out.slice(-15).join('\n').slice(0, 4000),
    }));
    s.running = null;
    return ok;
  });
  return s.running;
}

// Is this job due now?
function due(job, now) {
  const s = state[job.id];
  if (s.running) return null;
  const p = istParts(now);
  if (job.dailyAt) {
    if (s.lastDailyDate === p.date) return null;
    if (p.mins >= toMins(job.dailyAt)) return 'daily time';
    // Missed yesterday (PC off at that time) → run now.
    if (s.lastStart && now - s.lastStart > 26 * 3600e3) return 'missed last night';
    return null;
  }
  if (job.hours && (p.mins < toMins(job.hours[0]) || p.mins >= toMins(job.hours[1]))) return null;
  if (now - s.lastStart >= job.every * 60e3 - 5000) return s.lastStart ? 'timetable' : 'first run';
  return null;
}

// "Run now" from the HQ page: sync_jobs.run_requested_at newer than what we have seen.
async function checkRequests() {
  const rows = await safe('requests', () => db.from('sync_jobs').select('job_id, run_requested_at').not('run_requested_at', 'is', null));
  const asked = [];
  for (const r of rows || []) {
    const s = state[r.job_id];
    if (!s || !r.run_requested_at || r.run_requested_at === s.requestedSeen) continue;
    s.requestedSeen = r.run_requested_at;
    asked.push(r.job_id);
  }
  return asked;
}

// ---------------------------------------------------------------------------
// One copy only
// ---------------------------------------------------------------------------
function takeLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8')) || 0;
      if (age < 60e3 && pid && pid !== process.pid) {
        try { process.kill(pid, 0); log(`JCM Sync is already running (process ${pid}) — this copy stops.`); return false; } catch (_) { /* stale */ }
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch (_) { return true; }
}
const touchLock = () => { try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch (_) { /* ignore */ } };

// ---------------------------------------------------------------------------
async function main() {
  if (process.argv.includes('--list')) {
    for (const j of JOBS) console.log(`${j.id.padEnd(11)} ${describe(j).padEnd(26)} node ${j.args.join(' ')}`);
    return;
  }
  const onceAt = process.argv.indexOf('--once');
  if (onceAt >= 0) {
    const job = JOBS.find(j => j.id === process.argv[onceAt + 1]);
    if (!job) { console.log(`Unknown job. Choose one of: ${JOBS.map(j => j.id).join(', ')}`); process.exit(1); }
    await publishTimetable();
    const ok = await runJob(job, 'run by hand');
    process.exit(ok ? 0 : 1);
  }

  if (!takeLock()) process.exit(0);
  log(`JCM Sync started (process ${process.pid}) — ${JOBS.length} jobs${db ? '' : ' — WARNING: no SUPABASE_URL / SUPABASE_SERVICE_KEY in .env, status not saved'}`);
  await loadState();
  await publishTimetable();
  // Anything marked running belonged to a previous copy that stopped.
  await safe('reset', () => db.from('sync_jobs').update({ running: false }).eq('running', true));

  let lastHousekeeping = 0;
  let wasPaused = false;
  let nextFree = 0; // stagger: earliest time the next job may start

  const tick = async () => {
    touchLock();
    if (fs.existsSync(RESTART_FILE)) {
      try { fs.unlinkSync(RESTART_FILE); } catch (_) { /* ignore */ }
      if (!Object.values(state).some(s => s.running)) { log('jcm-sync.restart found — stopping so run-jcm-sync.bat starts the new copy'); process.exit(0); }
    }
    const now = Date.now();
    const paused = fs.existsSync(PAUSE_FILE);
    if (paused !== wasPaused) { log(paused ? 'PAUSED (jcm-sync.pause found) — no new runs' : 'resumed'); wasPaused = paused; }

    const asked = await checkRequests();
    if (now - lastHousekeeping > 10 * 60e3) {
      lastHousekeeping = now;
      await publishTimetable(); // also the "runner is alive" signal for HQ
      const cutoff = new Date(now - KEEP_RUNS_DAYS * 86400e3).toISOString();
      await safe('cleanup', () => db.from('sync_job_runs').delete().lt('started_at', cutoff));
    }
    if (paused) return;

    // Run now requests start at once; due jobs start one at a time, STAGGER_MS apart,
    // the one that has waited longest first (so a frequent job never starves the rest).
    const ready = [];
    for (const job of JOBS) {
      if (state[job.id].running) continue;
      if (asked.includes(job.id)) { runJob(job, 'Run now (HQ)'); continue; }
      const why = due(job, now);
      if (why) ready.push([job, why]);
    }
    if (!ready.length || Date.now() < nextFree) return;
    ready.sort((a, b) => state[a[0].id].lastStart - state[b[0].id].lastStart);
    const [job, why] = ready[0];
    nextFree = Date.now() + STAGGER_MS;
    runJob(job, why);
  };

  await tick();
  setInterval(() => { tick().catch(err => log(`tick error: ${err.message}`)); }, TICK_MS);
}

process.on('unhandledRejection', err => log(`unexpected: ${err && err.message ? err.message : err}`));
main().catch(err => { log(`FAILED to start: ${err.message}`); process.exit(1); });
