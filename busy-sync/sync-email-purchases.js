// sync-email-purchases.js
// Reads the brand invoices that arrive by email (Gmail, jcmretails@gmail.com) and copies
// them into Supabase (JCM-Busysql project) for the Email Purchase Summary page in JCM HQ
// (hq.jcmretails.com/#email-purchases).
//
// How it works, each run (JCM Sync job `email-purchases`, every 15 minutes):
//   1. Logs into Gmail over IMAP with the app password in .env and lists the mails that
//      arrived since the last run (with a 2-day overlap; the very first run starts at
//      email_bill_settings.scan_from).
//   2. Keeps only mails from the senders in email_bill_senders (brands that mail invoices).
//      Subjects that are plainly not invoices (despatch details, order acknowledgements,
//      sales orders, purchase orders, ageing) are skipped without reading them.
//   3. For each new mail: the PDF attachments and the mail text go to Claude, which
//      answers with the invoice(s) in a fixed JSON shape — supplier, invoice no. and date,
//      every item with qty / rate / GST / amount, and the totals. Credit and debit notes
//      are recorded too (doc_kind) but shown apart on the page.
//   4. Saves: email_scan_mails (one row per mail looked at, so nothing is read twice),
//      email_bills + email_bill_lines (one per invoice found), and the PDF in the private
//      Storage bucket email-bills. The mail's arrival time is kept on every bill, so the
//      brand's turnaround (invoice date → received) can be worked out later.
//
//   node sync-email-purchases.js              normal run
//   node sync-email-purchases.js --check      list the mails it would read; writes nothing, no Claude
//   node sync-email-purchases.js --as-history first run: load everything WITHOUT WhatsApps later
//   node sync-email-purchases.js --limit 5    read at most 5 new mails this run
//   node sync-email-purchases.js --days 30    look back 30 days (default: since the last run)
//
// Lives in D:\JCM-Supabase\files beside the other sync scripts; same .env and node_modules.
//   GMAIL_USER, GMAIL_APP_PASSWORD   (Google account → Security → App passwords)
//   ANTHROPIC_API_KEY                (console.anthropic.com)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
// Needs: npm install imapflow mailparser   (both pure JavaScript)
// Writes email-purchases.log in the same folder.

require('dotenv').config();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const AS_HISTORY = args.includes('--as-history');
const argVal = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const LIMIT = parseInt(argVal('--limit', '40'), 10);      // mails per run (each is one Claude call)
const DAYS = argVal('--days', null);

const MODEL = process.env.EMAIL_BILLS_MODEL || 'claude-sonnet-5-5';
const BUCKET = 'email-bills';
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const OVERLAP_MS = 2 * 86400000;

// Subjects that are never invoices (seen in the real mailbox). Checked before reading the mail.
const SKIP_SUBJECT = /despatch details|dispatch details|order acknowledg|sales order|purchase order|\bPO\b|aging|ageing|statement of account|payment advice|remittance/i;

const LOG_FILE = path.join(__dirname, 'email-purchases.log');
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) { /* logging must never stop the sync */ }
}
const txt = (s) => (s == null ? null : String(s).trim() || null);
const r2 = (n) => (n == null || n === '' || Number.isNaN(Number(n)) ? null : Math.round(Number(n) * 100) / 100);
const r3 = (n) => (n == null || n === '' || Number.isNaN(Number(n)) ? null : Math.round(Number(n) * 1000) / 1000);

function need(name) {
  if (!process.env[name] || /PASTE_/i.test(process.env[name])) throw new Error(`${name} is missing in .env`);
  return process.env[name];
}

// ---------- senders ----------
function senderMatches(address, senders) {
  const a = String(address || '').toLowerCase();
  const domain = a.split('@')[1] || '';
  for (const s of senders) {
    const m = s.match.toLowerCase();
    if (m.includes('@') ? a === m : (domain === m || domain.endsWith('.' + m))) return s;
  }
  return null;
}

// ---------- mail text ----------
// The L&K mails carry their invoice list as an HTML table: keep rows and cells readable.
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*\/\s*(tr|p|div|h\d|li|br)\s*>/gi, '\n')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(td|th)\s*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- Claude ----------
const TOOL = {
  name: 'record_documents',
  description: 'Record every invoice, credit note or debit note found in this email and its attachments.',
  input_schema: {
    type: 'object',
    properties: {
      documents: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            doc_kind: { type: 'string', enum: ['invoice', 'credit_note', 'debit_note'] },
            supplier_name: { type: 'string', description: 'The company that issued the document (the seller), as printed' },
            supplier_gstin: { type: 'string', description: '15-character GSTIN of the supplier, if printed' },
            invoice_no: { type: 'string', description: 'The document number exactly as printed' },
            invoice_date: { type: 'string', description: 'YYYY-MM-DD' },
            buyer_name: { type: 'string', description: 'Who it is billed to, as printed' },
            taxable_total: { type: 'number', description: 'Total before GST' },
            tax_total: { type: 'number', description: 'Total GST (CGST+SGST or IGST)' },
            grand_total: { type: 'number', description: 'Final amount payable, GST included, after round-off / freight / discounts' },
            note: { type: 'string', description: 'Anything you were unsure about, or blank' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Item description as printed, including model / code' },
                  hsn: { type: 'string' },
                  qty: { type: 'number' },
                  unit: { type: 'string' },
                  rate: { type: 'number', description: 'Price per unit BEFORE GST, after any line discount' },
                  gst_rate: { type: 'number', description: 'GST percent, e.g. 18' },
                  tax_amount: { type: 'number', description: 'GST amount on this line' },
                  amount: { type: 'number', description: 'Line value BEFORE GST (qty × rate, after discount)' },
                },
                required: ['name', 'qty', 'amount'],
              },
            },
          },
          required: ['doc_kind', 'supplier_name', 'invoice_no', 'grand_total', 'items'],
        },
      },
    },
    required: ['documents'],
  },
};

const SYSTEM = `You read supplier invoices received by J.C. Mittal & Sons (JCM Retails), Ratlam — an electrical goods distributor — and copy the figures out exactly as printed. Rules:
- Record every tax invoice, credit note and debit note in the email (attachments first, then the mail body). One email can carry several invoices (for example a list of invoices in a table); record each as its own document with its own items.
- Ignore purchase orders, order acknowledgements, despatch notes, statements, marketing text and email signatures.
- Items: one entry per printed line. Never merge or drop lines. Qty and rate as printed; rate and amount are BEFORE GST. If only a GST-inclusive rate is printed, work the pre-GST rate out from the GST percent.
- Totals as printed on the document. grand_total is the final payable amount.
- Dates as YYYY-MM-DD (Indian documents print dd.mm.yyyy or dd/mm/yyyy).
- If the document is not for J.C. Mittal / JCM at all, still record it and say so in note.
- If there is no invoice, credit note or debit note in the email at all, return an empty documents list.`;

async function askClaude(apiKey, mail, pdfs) {
  const content = [];
  for (const p of pdfs) {
    content.push({ type: 'text', text: `Attachment: ${p.filename}` });
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.buffer.toString('base64') } });
  }
  const body = (mail.text || '').slice(0, 60000);
  content.push({ type: 'text', text: `Email from: ${mail.from}\nSubject: ${mail.subject}\nReceived: ${mail.date}\n${pdfs.length ? '' : '(no PDF attachment — the invoice details are in the mail text below)\n'}\n--- mail text ---\n${body || '(empty)'}\n--- end ---\n\nRecord the documents with the record_documents tool.` });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      tools: [TOOL],
      messages: [{ role: 'user', content }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(data.error && data.error.message) || JSON.stringify(data).slice(0, 300)}`);
  const use = (data.content || []).find((c) => c.type === 'tool_use');
  let docs;
  if (use) docs = use.input && use.input.documents;
  else {
    // No tool call: look for a JSON answer in the text instead.
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const m = text.match(/\{[\s\S]*"documents"[\s\S]*\}/);
    if (!m) throw new Error(`Claude gave no record_documents answer: ${text.slice(0, 200)}`);
    docs = JSON.parse(m[0]).documents;
  }
  docs = Array.isArray(docs) ? docs : [];
  const usage = data.usage || {};
  return { docs, usage: `${usage.input_tokens || 0} in / ${usage.output_tokens || 0} out` };
}

// ---------- Supabase ----------
async function existingBill(supabase, supplier, invoiceNo) {
  if (!supplier || !invoiceNo) return null;
  const { data, error } = await supabase.from('email_bills').select('id, message_id')
    .ilike('supplier_name', supplier).eq('invoice_no', invoiceNo).limit(1);
  if (error) throw new Error(`checking duplicates: ${error.message}`);
  return data && data[0] ? data[0] : null;
}

async function saveMail(supabase, row) {
  const { error } = await supabase.from('email_scan_mails').upsert(row, { onConflict: 'message_id' });
  if (error) throw new Error(`saving mail row: ${error.message}`);
}

async function uploadPdf(supabase, messageId, seq, pdf) {
  if (!pdf) return null;
  const safe = crypto.createHash('md5').update(messageId).digest('hex').slice(0, 12);
  const p = `${new Date().toISOString().slice(0, 7)}/${safe}-${seq}.pdf`;
  const up = await supabase.storage.from(BUCKET).upload(p, pdf.buffer, { contentType: 'application/pdf', upsert: true });
  if (up.error) { log(`  PDF not stored (${up.error.message})`); return null; }
  return p;
}

// ---------- main ----------
async function main() {
  const started = new Date();
  const user = need('GMAIL_USER'), pass = need('GMAIL_APP_PASSWORD');
  const apiKey = CHECK ? null : need('ANTHROPIC_API_KEY');
  const supabase = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } });

  const settingsQ = await supabase.from('email_bill_settings').select('*').eq('id', 1).maybeSingle();
  if (settingsQ.error) throw new Error(`reading email_bill_settings: ${settingsQ.error.message} — run the setup SQL first`);
  const settings = settingsQ.data || {};
  const sendersQ = await supabase.from('email_bill_senders').select('*').eq('enabled', true);
  if (sendersQ.error) throw new Error(`reading senders: ${sendersQ.error.message}`);
  const senders = sendersQ.data || [];
  if (!senders.length) throw new Error('email_bill_senders is empty — nothing to look for');

  // Window: since the last run (minus 2 days), never before scan_from; --days overrides.
  let since;
  if (DAYS) since = new Date(Date.now() - Number(DAYS) * 86400000);
  else if (settings.last_sync_at) since = new Date(new Date(settings.last_sync_at).getTime() - OVERLAP_MS);
  else since = new Date(`${settings.scan_from || '2026-10-01'}T00:00:00+05:30`);
  const floor = new Date(`${settings.scan_from || '2026-10-01'}T00:00:00+05:30`);
  if (since < floor && !DAYS) since = floor;

  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  let listed = 0, matched = 0, read = 0, bills = 0, skipped = 0, failed = 0, dupes = 0;
  const notes = [];
  try {
    const lock = await client.getMailboxLock('[Gmail]/All Mail');
    try {
      // Envelopes only (cheap): sender, subject, date, Message-ID.
      const candidates = [];
      for await (const m of client.fetch({ since }, { uid: true, envelope: true })) {
        listed++;
        const env = m.envelope || {};
        const from = env.from && env.from[0] ? env.from[0].address : '';
        const sender = senderMatches(from, senders);
        if (!sender) continue;
        matched++;
        candidates.push({ uid: m.uid, from, subject: env.subject || '', date: env.date ? new Date(env.date) : null, messageId: env.messageId || `uid-${m.uid}@gmail`, sender });
      }
      candidates.sort((a, b) => (a.date || 0) - (b.date || 0));

      // Which of these were already looked at? A mail that failed last time is tried again.
      const seen = new Set();
      for (let i = 0; i < candidates.length; i += 200) {
        const ids = candidates.slice(i, i + 200).map((c) => c.messageId);
        const { data, error } = await supabase.from('email_scan_mails').select('message_id').in('message_id', ids).neq('status', 'failed');
        if (error) throw new Error(`reading email_scan_mails: ${error.message}`);
        for (const r of data || []) seen.add(r.message_id);
      }
      const fresh = candidates.filter((c) => !seen.has(c.messageId));

      if (CHECK) {
        log(`CHECK ONLY — ${listed} mails since ${since.toISOString().slice(0, 10)}, ${matched} from invoice senders, ${fresh.length} not read yet. Nothing written.`);
        for (const c of fresh) console.log(`  ${c.date ? c.date.toISOString().slice(0, 16).replace('T', ' ') : '?'}  ${c.sender.brand.padEnd(22)}  ${SKIP_SUBJECT.test(c.subject) ? '[skip] ' : ''}${c.subject}`);
        return;
      }

      for (const c of fresh.slice(0, LIMIT)) {
        const base = { message_id: c.messageId, uid: c.uid, sender: c.from, subject: c.subject, received_at: c.date ? c.date.toISOString() : null };
        if (SKIP_SUBJECT.test(c.subject)) {
          await saveMail(supabase, { ...base, status: 'skipped', note: 'subject says it is not an invoice' });
          skipped++;
          continue;
        }
        read++;
        try {
          const { content } = await client.download(c.uid, undefined, { uid: true });
          const parsed = await simpleParser(content);
          const pdfs = (parsed.attachments || [])
            .filter((a) => (a.contentType === 'application/pdf' || /\.pdf$/i.test(a.filename || '')) && a.content && a.content.length <= MAX_PDF_BYTES)
            .map((a) => ({ filename: a.filename || 'invoice.pdf', buffer: a.content }));
          const otherFiles = (parsed.attachments || []).filter((a) => !pdfs.find((p) => p.buffer === a.content)).map((a) => a.filename).filter(Boolean);
          const text = (parsed.text && parsed.text.trim()) || htmlToText(parsed.html);
          const mail = { from: c.from, subject: c.subject, date: c.date ? c.date.toISOString() : '', text: otherFiles.length ? `(other attachments not read: ${otherFiles.join(', ')})\n${text}` : text };

          const { docs, usage } = await askClaude(apiKey, mail, pdfs);
          // The mail row first: every bill points at it.
          await saveMail(supabase, { ...base, status: 'reading', note: `Claude ${usage}` });
          let saved = 0;
          const noteParts = [];
          for (let i = 0; i < docs.length; i++) {
            const d = docs[i];
            const supplier = txt(d.supplier_name) || c.sender.brand;
            const invNo = txt(d.invoice_no);
            const dupe = await existingBill(supabase, supplier, invNo);
            if (dupe) { dupes++; noteParts.push(`${invNo} already in (mail ${dupe.message_id})`); continue; }
            const items = Array.isArray(d.items) ? d.items : [];
            const lines = items.map((it, n) => ({
              sr_no: n + 1, item_name: txt(it.name) || 'Item', hsn: txt(it.hsn), qty: r3(it.qty), unit: txt(it.unit),
              rate: r2(it.rate), gst_rate: r2(it.gst_rate), tax_amount: r2(it.tax_amount), amount: r2(it.amount),
            }));
            // Match the PDF to the document: one PDF → every document; several → by position.
            const pdf = pdfs.length === 1 ? pdfs[0] : pdfs[i] || null;
            const attachment_path = await uploadPdf(supabase, c.messageId, i + 1, pdf);
            const header = {
              message_id: c.messageId, seq: i + 1, sender: c.from, subject: c.subject, received_at: base.received_at,
              doc_kind: ['invoice', 'credit_note', 'debit_note'].includes(d.doc_kind) ? d.doc_kind : 'invoice',
              supplier_name: supplier, supplier_gstin: txt(d.supplier_gstin), brand: c.sender.brand,
              invoice_no: invNo, invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(d.invoice_date || '') ? d.invoice_date : null,
              buyer_name: txt(d.buyer_name),
              taxable_total: r2(d.taxable_total), tax_total: r2(d.tax_total), bill_total: r2(d.grand_total),
              item_count: lines.length, total_qty: r3(lines.reduce((s, l) => s + (l.qty || 0), 0)),
              source: pdf ? 'pdf' : 'body', attachment_name: pdf ? pdf.filename : null, attachment_path,
              model: MODEL, extract_note: txt(d.note), raw_json: d,
              notify_state: AS_HISTORY || d.doc_kind !== 'invoice' ? 'skipped' : 'pending',
            };
            const ins = await supabase.from('email_bills').upsert(header, { onConflict: 'message_id,seq' }).select('id').single();
            if (ins.error) throw new Error(`saving bill: ${ins.error.message}`);
            const billId = ins.data.id;
            await supabase.from('email_bill_lines').delete().eq('bill_id', billId);
            if (lines.length) {
              const { error } = await supabase.from('email_bill_lines').insert(lines.map((l) => ({ ...l, bill_id: billId })));
              if (error) throw new Error(`saving lines: ${error.message}`);
            }
            saved++; bills++;
            log(`  ${supplier} | ${header.doc_kind} ${invNo || '?'} dated ${header.invoice_date || '?'} | ${lines.length} items | total ${header.bill_total} | from ${pdf ? pdf.filename : 'mail text'}`);
          }
          const status = saved ? 'done' : dupes && !docs.length ? 'done' : docs.length ? 'done' : 'no_invoice';
          await saveMail(supabase, { ...base, status, bills: saved, note: [`Claude ${usage}`, ...noteParts].join('; ') });
        } catch (err) {
          failed++;
          log(`  FAILED ${c.subject}: ${err.message}`);
          await saveMail(supabase, { ...base, status: 'failed', note: String(err.message).slice(0, 500) }).catch(() => {});
        }
      }
      if (fresh.length > LIMIT) notes.push(`${fresh.length - LIMIT} more wait for the next run`);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  const note = `${listed} mails since ${since.toISOString().slice(0, 10)}, ${matched} from brands; read ${read}, bills ${bills}, skipped ${skipped}, duplicates ${dupes}, failed ${failed}${notes.length ? '; ' + notes.join('; ') : ''}${AS_HISTORY ? ' (history, no WhatsApp)' : ''}`;
  await supabase.from('email_bill_settings').upsert({ id: 1, last_sync_at: started.toISOString(), last_sync_note: note }, { onConflict: 'id' });
  log(note);
}

main().catch((err) => {
  log(`FAILED: ${err.message || err}`);
  process.exit(1);
});
