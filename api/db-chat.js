import { applyCors } from './_cors.js'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'

// Same project as src/supabase.js — this is the public project URL, not a secret.
const SUPABASE_URL = 'https://cmtnzmfuasniicsdxyle.supabase.co'
// Same project as src/supabase-busy.js — the JCM-Busysql project this chat
// actually queries. Its anon key (used everywhere else in the app) can only
// read items/item_group_map/item_groups; run_readonly_query is granted to
// service_role only, so answering arbitrary questions needs that key here.
const SUPABASE_BUSY_URL = 'https://jlkjjqnmhsgefpluemyz.supabase.co'

const MODEL = 'claude-opus-5'

// Mirrors run_readonly_query's own guard in Postgres (see supabase/db-chat.sql)
// — checked again here, before the query ever leaves this function, so a bug
// or future change in the DB function isn't the only thing standing between
// a bad query and the database.
function isSafeSelect(sql) {
  const trimmed = sql.trim()
  if (!/^select\b/i.test(trimmed)) return false
  if (/\b(insert|update|delete|drop|alter|truncate|grant|revoke|create)\b/i.test(trimmed)) return false
  // Reject anything but a single statement -- a trailing semicolon is fine,
  // a second one after it is not.
  if (trimmed.replace(/;\s*$/, '').includes(';')) return false
  return true
}

const SqlAnswer = z.object({
  sql: z.string().describe('A single PostgreSQL SELECT statement that answers the question, using only the tables/columns listed in the schema.'),
})

// Schema introspection is the same read-only RPC everything else here uses —
// no separate PostgREST path into information_schema is needed. Cached
// in-memory per warm serverless instance; a cold start just re-fetches it.
let cachedSchema = null
let cachedSchemaAt = 0
const SCHEMA_CACHE_MS = 10 * 60 * 1000

async function getSchemaSummary(supabaseBusyAdmin) {
  if (cachedSchema && Date.now() - cachedSchemaAt < SCHEMA_CACHE_MS) return cachedSchema

  const { data, error } = await supabaseBusyAdmin.rpc('run_readonly_query', {
    query: `
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position
    `,
  })
  if (error) throw new Error(`Schema introspection failed: ${error.message}`)

  const byTable = new Map()
  for (const row of data || []) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, [])
    byTable.get(row.table_name).push(`${row.column_name} (${row.data_type})`)
  }

  const summary = [...byTable.entries()]
    .map(([table, cols]) => `${table}: ${cols.join(', ')}`)
    .join('\n')

  cachedSchema = summary
  cachedSchemaAt = Date.now()
  return summary
}

export default async function handler(req, res) {
  // Must run before the method check: the app's cross-origin POST is
  // preceded by an OPTIONS, which that check would answer with a 405.
  if (applyCors(req, res)) return
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const busyServiceRoleKey = process.env.SUPABASE_BUSY_SERVICE_ROLE_KEY
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  if (!serviceRoleKey || !busyServiceRoleKey || !anthropicApiKey) {
    console.error('db-chat is missing required env vars', {
      hasServiceRoleKey: !!serviceRoleKey,
      hasBusyServiceRoleKey: !!busyServiceRoleKey,
      hasAnthropicApiKey: !!anthropicApiKey,
    })
    res.status(500).json({ error: 'AI chat is not configured yet' })
    return
  }

  // ---- Auth check: admin only, same gate as the Items Management page
  // itself. The frontend's own admin check is a UX convenience, never
  // trusted here. ----
  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })

  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) {
    res.status(401).json({ error: 'Missing Authorization header' })
    return
  }

  const { data: callerData, error: callerErr } = await supabaseAdmin.auth.getUser(token)
  if (callerErr || !callerData?.user) {
    res.status(401).json({ error: 'Invalid or expired session' })
    return
  }

  const { data: callerProfile, error: callerProfileErr } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', callerData.user.id)
    .maybeSingle()
  if (callerProfileErr) {
    console.error('Failed to check caller admin status:', callerProfileErr)
    res.status(500).json({ error: 'Something went wrong. Try again.' })
    return
  }
  if (callerProfile?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' })
    return
  }

  const question = String(req.body?.question || '').trim()
  if (!question) {
    res.status(400).json({ error: 'Question is required' })
    return
  }

  const supabaseBusyAdmin = createClient(SUPABASE_BUSY_URL, busyServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
  const anthropic = new Anthropic({ apiKey: anthropicApiKey })

  try {
    const schemaSummary = await getSchemaSummary(supabaseBusyAdmin)

    // ---- Round trip 1: question + schema -> one SELECT statement ----
    const sqlResponse = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      system: `You write PostgreSQL SELECT queries against a lighting/electrical distributor's Busy accounting database (items, item groups, sales history, invoices, dues, customers). You are given the exact schema below -- use ONLY these tables and columns, never invent one.

Rules:
- Exactly one SELECT statement. Never write INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/GRANT/REVOKE/CREATE -- this connection is read-only and anything else will be rejected before it runs.
- If the question can't be answered from this schema, return a query like: select 'This can''t be answered from the available data.' as message
- Keep it simple and correct over clever. Add reasonable ORDER BY / LIMIT when the question implies "top N" or "recent".

Schema:
${schemaSummary}`,
      messages: [{ role: 'user', content: question }],
      output_config: { format: zodOutputFormat(SqlAnswer) },
    })

    if (sqlResponse.stop_reason === 'refusal' || !sqlResponse.parsed_output) {
      res.status(200).json({ answer: "I can't answer that question.", sql: null })
      return
    }

    const sql = sqlResponse.parsed_output.sql.trim()
    if (!isSafeSelect(sql)) {
      res.status(200).json({ answer: "I couldn't turn that into a safe read-only query. Try rephrasing the question.", sql })
      return
    }

    // ---- Run the query through the read-only RPC (defense in depth: the
    // DB function re-checks everything isSafeSelect just checked) ----
    const { data: rows, error: queryErr } = await supabaseBusyAdmin.rpc('run_readonly_query', { query: sql })
    if (queryErr) {
      res.status(200).json({ answer: `That query didn't run: ${queryErr.message}`, sql })
      return
    }

    // ---- Round trip 2: question + result rows -> plain-language answer ----
    const answerResponse = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: `You answer questions about a lighting/electrical distributor's business data in plain, concise language for someone who doesn't know SQL. Don't mention SQL, tables, or column names unless the question is specifically about the data structure. If the result set is empty, say so plainly rather than guessing why.`,
      messages: [{
        role: 'user',
        content: `Question: ${question}\n\nQuery result (JSON, up to 200 rows):\n${JSON.stringify(rows ?? [])}`,
      }],
    })

    if (answerResponse.stop_reason === 'refusal') {
      res.status(200).json({ answer: "I can't answer that question.", sql })
      return
    }

    const textBlock = answerResponse.content.find(b => b.type === 'text')
    res.status(200).json({ answer: textBlock?.text || "I couldn't come up with an answer for that.", sql })
  } catch (err) {
    console.error('db-chat handler error:', err)
    res.status(500).json({ error: 'Something went wrong. Try again.' })
  }
}
