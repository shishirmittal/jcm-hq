// busy-sync/sync-stock-live.js
//
// Refreshes ONLY the stock figures on items, often enough that the Stock tab
// in the app is useful at the counter. Meant to run every 10 minutes during
// business hours via Windows Task Scheduler (see run-stock-live.bat).
//
// This is deliberately NOT sync.js with a shorter timer. The nightly sync does
// seven SQL queries, two of which scan the whole of DailySum, and it deletes
// and re-inserts every invoice line of the year on every run — 81 seconds for
// 9,544 items and 25,609 sales rows. None of that has anything to do with
// stock. This script does one query and writes at most four columns.
//
// Run manually with: node sync-stock-live.js

require('dotenv').config();
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'sync-stock-live.log');
const GODOWN = 201; // Freeganj, the same godown sync.js filters to.
const JOB_NAME = 'stock-live';
// Stock has to be written a row at a time (see the UPDATE below), so a few go
// at once to keep a busy run short. Small on purpose: this shares the database
// with the counter, and a ten-minute job has no reason to be in a hurry.
const WRITE_CONCURRENCY = 8;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function parseServer(raw) {
  if (raw.includes(',')) {
    const [host, port] = raw.split(',');
    return { server: host.trim(), port: parseInt(port.trim(), 10) };
  }
  return { server: raw.trim() };
}

const sqlConfig = {
  ...parseServer(process.env.BUSY_SERVER),
  database: process.env.BUSY_DATABASE,
  user: process.env.BUSY_USER,
  password: process.env.BUSY_PASSWORD,
  options: { trustServerCertificate: true, enableArithAbort: true },
  // A run that cannot finish inside the gap to the next one is a run that
  // should give up rather than pile on top of it.
  requestTimeout: 120000,
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ---------------------------------------------------------------------------
// The tiebreaker
// ---------------------------------------------------------------------------
// sync.js picks the latest DailySum row with
//   ROW_NUMBER() OVER (PARTITION BY MasterCode1 ORDER BY Date DESC)
// and no tiebreaker. DailySum can hold more than one row per item per date —
// that is exactly why the nightly's sales query has to SUM(...) GROUP BY
// CAST(Date AS DATE). When the top rows tie on Date, SQL Server is free to
// pick either, and it may pick differently on the next run. Nightly, nobody
// notices. Six times an hour, the number on the phone flickers between two
// values for those items.
//
// So the tiebreaker is discovered rather than assumed: if DailySum has an
// identity column, that is both unique and monotonic with insertion order,
// which is precisely the "latest row" we want. The lookup is one cheap query
// against sys.identity_columns at startup.
async function findTiebreaker(pool) {
  const { recordset } = await pool.request().query(`
    SELECT TOP 1 c.name
    FROM sys.identity_columns c
    WHERE c.object_id = OBJECT_ID('DailySum')
  `);
  if (recordset.length) {
    const col = recordset[0].name;
    log(`Tiebreaker: DailySum.${col} (identity column) — row pick is stable.`);
    return `, [${col}] DESC`;
  }
  // No identity column. Fall back to the LOWEST balance among rows tied on
  // Date. Still arbitrary, but arbitrary-and-fixed beats arbitrary-and-
  // changing: the figure stops flickering, and erring low means the counter
  // is never promised stock that is not there.
  log('Tiebreaker: no identity column on DailySum — falling back to the lowest');
  log('  balance among rows tied on Date. Stable, but conservative. Send the');
  log('  output of the query in README-stock-live.md if you want this sharpened.');
  return ', D1 ASC';
}

// Latest stock per item for one godown. Mirrors sync.js's LatestStock, with
// the tiebreaker added and everything the Stock tab does not need removed.
//
// Note there is no opening balance and no arithmetic here, in sync.js either:
// D1 is Busy's own running balance, so whatever Busy holds for this godown is
// what gets reported — negatives included.
function stockQuery(tiebreaker) {
  return `
    WITH LatestStock AS (
        SELECT MasterCode1, D1 AS StockQty, D3 AS StockValue, D4 AS AvgRate,
               ROW_NUMBER() OVER (
                   PARTITION BY MasterCode1
                   ORDER BY Date DESC${tiebreaker}
               ) AS rn
        FROM DailySum
        WHERE MasterCode2 = @godown
    )
    SELECT m.Code AS code,
           ls.StockQty  AS stock_qty,
           ls.StockValue AS stock_value,
           ls.AvgRate   AS avg_rate
    FROM Master1 m
    INNER JOIN LatestStock ls ON ls.MasterCode1 = m.Code AND ls.rn = 1
    WHERE m.MasterType = 6
      AND ls.StockQty IS NOT NULL;
  `;
}

// Busy's Master1.Code is numeric and Supabase's items.code is text, so the
// two sides can hand us 1234 and '1234' for the same item. Matching on a
// trimmed string means the lookup cannot be thrown by that, or by padding out
// of a CHAR column. The code as Supabase actually stores it is kept alongside,
// because that is the value the UPDATE has to filter on.
const normalizeCode = code => String(code).trim();

// Reads every item code Supabase currently holds a stock figure for, so the
// run can write only what actually moved.
async function readCurrentStock() {
  const current = new Map();
  const protectedCodes = new Set();
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('items')
      .select('code, stock_qty, stock_source')
      // Paging without an ORDER BY is paging in whatever order Postgres feels
      // like returning rows in, which is not promised to be the same order
      // twice. Rows then fall between the pages and never reach this map, and
      // an item missing from it is silently left un-refreshed below. Ordering
      // by the key makes the window stable.
      .order('code')
      .range(from, from + 999);
    if (error) throw new Error(`Failed reading current stock: ${error.message}`);
    if (!data || !data.length) break;
    for (const row of data) {
      const key = normalizeCode(row.code);
      current.set(key, { code: row.code, stock_qty: row.stock_qty });
      // The protection sync.js already implements, applied here too and for
      // the same reason: a busy_report_* figure is stock somebody recovered
      // by hand because DailySum could not place the item. This script must
      // never write over that. needs_manual_check rows are protected by
      // construction — DailySum returns no row for them, so they are not in
      // the result set at all — but the label is checked anyway so the rule
      // reads the same way it is written down.
      if (typeof row.stock_source === 'string' &&
          (row.stock_source.startsWith('busy_report_') || row.stock_source === 'needs_manual_check')) {
        protectedCodes.add(key);
      }
    }
    if (data.length < 1000) break;
    from += 1000;
  }
  return { current, protectedCodes };
}

async function main() {
  const startedAt = new Date();
  log('=== Stock refresh started ===');
  let written = 0;
  let pool = null;

  try {
    pool = await sql.connect(sqlConfig);
    const tiebreaker = await findTiebreaker(pool);

    const { recordset } = await pool
      .request()
      .input('godown', sql.Int, GODOWN)
      .query(stockQuery(tiebreaker));
    log(`DailySum placed ${recordset.length} items in godown ${GODOWN}.`);

    await pool.close();
    pool = null;

    const { current, protectedCodes } = await readCurrentStock();

    // Only what changed. During business hours a ten-minute window moves a
    // handful of items out of three and a half thousand, so this is what keeps
    // the cadence affordable — all the more now that each write is its own
    // round trip.
    const changed = [];
    let skippedProtected = 0;
    let skippedUnknown = 0;
    for (const row of recordset) {
      const key = normalizeCode(row.code);
      if (protectedCodes.has(key)) { skippedProtected++; continue; }
      // Only existing items are updated. A brand-new item code is the nightly
      // sync's job to introduce, with its name, price and category — this
      // script has none of that and must not create half a row.
      const existing = current.get(key);
      if (!existing) { skippedUnknown++; continue; }
      const before = existing.stock_qty;
      const after = row.stock_qty;
      if (before !== null && before !== undefined && Number(before) === Number(after)) continue;
      changed.push({
        // The code as Supabase spells it, not as Busy does, so the filter
        // below matches whatever is actually in the column.
        code: existing.code,
        stock_qty: row.stock_qty,
        stock_value: row.stock_value,
        avg_rate: row.avg_rate,
      });
    }

    log(`${changed.length} item(s) changed; ${skippedProtected} skipped as manually-imported or unplaceable.`);
    // Items Busy can place but Supabase has never heard of. Expected to be 0
    // between nightly runs; a number that keeps climbing means the nightly is
    // not introducing new items, which this script deliberately will not do.
    if (skippedUnknown) {
      log(`${skippedUnknown} item(s) in DailySum are not in Supabase yet — left for the nightly sync.`);
    }
    // Named in the log before anything is written, so a failed run says which
    // items it was holding rather than leaving it to be worked out afterwards.
    if (changed.length) {
      const names = changed.map(c => c.code);
      const shown = names.slice(0, 20).join(', ');
      log(`Updating: ${shown}${names.length > 20 ? `, and ${names.length - 20} more` : ''}`);
    }

    // stock_source is deliberately NOT written here. The nightly sync owns
    // that column, and it encodes pricing as well as provenance ('unpriced'
    // wins over 'daily_sum' in its CASE even when DailySum placed the item
    // perfectly well). If this script wrote 'daily_sum' the two would
    // overwrite each other every night. Whether an item has live stock is
    // answered by stock_qty being present, not by the label.
    // UPDATE, not upsert. An upsert is an INSERT that falls back to an UPDATE,
    // and Postgres checks the proposed row against the table's NOT NULL
    // constraints BEFORE it goes looking for the row to conflict with. A
    // stock-only payload has no items.name in it, so the insert was rejected
    // on that column even though both items already existed and only needed
    // four numbers changed. That is what stopped the first scheduled run.
    //
    // An UPDATE touches only the columns named here, cannot invent a row, and
    // does not care what else the table requires — so this is also the
    // stronger version of the "never introduce an item" rule the script is
    // supposed to keep: with no INSERT in the statement there is no path to
    // one, rather than a guard above being the only thing preventing it.
    const notMatched = [];
    for (let i = 0; i < changed.length; i += WRITE_CONCURRENCY) {
      const batch = changed.slice(i, i + WRITE_CONCURRENCY);
      // Errors are resolved into the result rather than thrown, so one bad
      // row cannot leave its neighbours rejecting unhandled.
      const results = await Promise.all(batch.map(item =>
        supabase
          .from('items')
          .update({
            stock_qty: item.stock_qty,
            stock_value: item.stock_value,
            avg_rate: item.avg_rate,
          }, { count: 'exact' })
          .eq('code', item.code)
          .then(({ error, count }) => ({ item, error, count }))
      ));
      for (const r of results) {
        if (r.error) throw new Error(`Supabase update failed for ${r.item.code}: ${r.error.message}`);
        // count comes back 0 when the filter matched nothing, which would mean
        // the code in the map is not the code in the column after all. Worth
        // saying out loud rather than counting as written.
        if (r.count === 0) notMatched.push(r.item.code);
        else written++;
      }
    }
    if (notMatched.length) {
      log(`WARNING: ${notMatched.length} item(s) matched no row on code: ${notMatched.slice(0, 20).join(', ')}`);
    }

    const ms = Date.now() - startedAt.getTime();
    await supabase.from('sync_log').insert({
      job: JOB_NAME,
      items_synced: written,
      sales_rows_synced: 0,
      status: 'success',
    });
    log(`=== Stock refresh finished: ${written} item(s) written in ${(ms / 1000).toFixed(1)}s ===`);
  } catch (err) {
    log(`ERROR: ${err.message}`);
    try {
      await supabase.from('sync_log').insert({
        job: JOB_NAME,
        items_synced: written,
        sales_rows_synced: 0,
        status: 'error',
        error_message: err.message,
      });
    } catch (logErr) {
      log(`Could not write the failure to sync_log either: ${logErr.message}`);
    }
    process.exitCode = 1;
  } finally {
    if (pool) { try { await pool.close(); } catch { /* already closing */ } }
  }
}

main();
