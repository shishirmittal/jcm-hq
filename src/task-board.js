import { supabase, getCurrentProfile } from './supabase.js'
import { openSidebar, avatarColor, refreshNavBadges } from './sidebar.js'
import { isAdminProfile } from './permissions.js'
import { esc, todayISO, addDays, parseLocalDate, skeletonList } from './utils.js'
import { icon } from './icons.js'

// ---------------------------------------------------------------------------
// Card types
// ---------------------------------------------------------------------------
// One entry per `team_tasks.task_type` value — label, glyph, and the words
// that make the composer guess this card. More types are expected, so
// everything the UI needs about a type lives here and nowhere else: the
// stacks, the composer chips and the keyword detection all read this list, so
// adding a fifth card means adding a fifth object (plus its enum value in
// Postgres) and touching nothing else on this screen.
export const CARD_TYPES = [
  {
    id: 'payment', label: 'Payments', short: 'Payment', icon: 'card',
    keywords: ['payment', 'paid', 'invoice', 'bill', 'cheque', 'cash', 'refund', 'outstanding', 'advance', 'recovery', 'receipt'],
  },
  {
    // 'dispatch', 'deliver' and 'shipment' used to live here; they belong to
    // Pending Deliveries below now, so ordering keeps the words about placing
    // an order and deliveries keeps the words about it arriving.
    id: 'order', label: 'Material Orders', short: 'Order', icon: 'box',
    keywords: ['order', 'material', 'stock', 'purchase', 'supplier', 'indent', 'restock', 'procure'],
  },
  {
    id: 'client', label: 'Client Requests', short: 'Client', icon: 'users',
    keywords: ['client', 'customer', 'quotation', 'quote', 'enquiry', 'inquiry', 'sample', 'callback', 'follow', 'architect', 'electrician'],
  },
  {
    id: 'service', label: 'Service Urgencies', short: 'Service', icon: 'bolt',
    keywords: ['service', 'repair', 'complaint', 'fault', 'faulty', 'warranty', 'replacement', 'breakdown', 'installation', 'technician', 'defective'],
  },
  {
    id: 'delivery', label: 'Pending Deliveries', short: 'Delivery', icon: 'truck',
    keywords: ['deliver', 'dispatch', 'shipment', 'courier', 'consignment', 'transport', 'vehicle', 'driver', 'unload', 'pickup'],
  },
  {
    // Chasing money that is owed, as opposed to recording money that came in
    // — hence a card of its own, and a circular chase arrow rather than a
    // second card outline, which at 14px was indistinguishable from the
    // Payments glyph. Open to the whole team; the restriction on Payments is
    // about seeing receipts, not about asking for them.
    id: 'payment_followup', label: 'Payment Follow Up', short: 'Follow up', icon: 'chase',
    keywords: ['followup', 'chase', 'remind', 'reminder', 'overdue', 'unpaid', 'pending payment', 'due amount', 'collect', 'balance'],
  },
  {
    // adminOnly gates FILING only, not seeing. Only an admin can open an
    // Other task, but once one is assigned to someone it is their work like
    // any other: the stack shows on their board and they can pass it on or
    // finish it. Hiding the whole card meant an assignee could not see the
    // task they had been given at all.
    id: 'other', label: 'Other Tasks', short: 'Other', icon: 'ellipsis', adminOnly: true,
    keywords: ['misc', 'miscellaneous', 'admin', 'general', 'sundry', 'other'],
  },
]

const TYPE_BY_ID = Object.fromEntries(CARD_TYPES.map(t => [t.id, t]))

// Built once rather than per keystroke — detectType() runs on every input event.
const TYPE_RE = Object.fromEntries(
  CARD_TYPES.map(t => [t.id, new RegExp('\\b(?:' + t.keywords.join('|') + ')', 'gi')])
)

// adminOnly scopes are filtered out for everyone else, not just disabled —
// the button never reaches a non-admin's DOM. RLS is what actually decides
// which rows come back, so 'all' on a non-admin would silently behave like
// 'everything I can see' and read as a broken filter rather than a denial.
const SCOPES = [
  { id: 'in', label: "Everything I'm in" },
  { id: 'to-me', label: 'Assigned to me' },
  { id: 'by-me', label: 'Assigned by me' },
  { id: 'all', label: 'All tasks', adminOnly: true },
]

// The four date buckets shown as KPI chips. `test` takes the same
// days-until-due number the colour rule uses, so a chip can never disagree
// with the dots underneath it.
const KPIS = [
  { id: 'overdue', label: 'Overdue', icon: 'alert-triangle', tone: 'red', test: d => d < 0 },
  { id: 'today', label: 'Due today', icon: 'clock', tone: 'red', test: d => d === 0 },
  { id: 'soon', label: 'Next 3 days', icon: 'calendar', tone: 'amber', test: d => d >= 1 && d <= 3 },
  { id: 'later', label: 'Later', icon: 'layers', tone: 'green', test: d => d > 3 },
]

const HISTORY_VERBS = {
  filed: 'filed this for',
  passed: 'passed it to',
  sent_back: 'sent it back to',
  done: 'marked it done',
  due_changed: 'changed the due date',
  edited: 'edited the text',
}

const DAY_STRIP_LENGTH = 15

// Two different questions, and the handover is explicit that they are not
// the same one. Whether the ASSIGN BAR is the phone sheet is about width.
// Whether a ROW opens on tap is about whether a pointer can hover at all —
// so a big tablet with no mouse gets the desktop bar and tap-to-expand rows.
const PHONE_QUERY = '(max-width: 860px)'
const TOUCH_QUERY = '(hover: none)'
const isPhoneLayout = () => window.matchMedia(PHONE_QUERY).matches
const isTouchLayout = () => window.matchMedia(TOUCH_QUERY).matches

// Which stacks are folded shut, remembered per device. A purely local UI
// preference — deliberately not on the profile, since which cards someone
// wants out of the way on their phone has nothing to do with the phone they
// pick up next. Only read on mobile (the fold is a mobile-only affordance),
// but stored regardless so it survives rotating between the two layouts.
const COLLAPSED_STACKS_KEY = 'taskBoardCollapsedStacks'

function loadCollapsedStacks() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_STACKS_KEY) || '[]')
    // Anything not a currently-known card id is dropped, so a renamed or
    // retired type cannot leave a stack stuck shut with no way to reopen it.
    return new Set(Array.isArray(raw) ? raw.filter(id => TYPE_BY_ID[id]) : [])
  } catch {
    return new Set()
  }
}

function saveCollapsedStacks(set) {
  try {
    localStorage.setItem(COLLAPSED_STACKS_KEY, JSON.stringify([...set]))
  } catch {
    // Private mode or blocked storage: the fold still works for this
    // session, it just will not be remembered. Not worth failing over.
  }
}

// ---------------------------------------------------------------------------
// Date + colour helpers
// ---------------------------------------------------------------------------

// Whole calendar days from today to `dueDate`, negative when overdue. Both
// sides go through parseLocalDate so a Postgres `date` is compared as a
// calendar date and never drifts a day on a timezone boundary. A task with no
// due date reports as the furthest-away thing on the board, which is what
// sorts it last and colours it green.
function daysUntil(dueDate) {
  if (!dueDate) return Infinity
  const MS_PER_DAY = 86400000
  const from = parseLocalDate(todayISO()).getTime()
  const to = parseLocalDate(dueDate).getTime()
  return Math.round((to - from) / MS_PER_DAY)
}

// The entire priority system: there is no urgency column anywhere, a task's
// colour is purely how close its due date is. Due today or already past is
// red, the next three days amber, anything beyond that green.
function dueTone(dueDate) {
  const days = daysUntil(dueDate)
  if (days <= 0) return 'red'
  if (days <= 3) return 'amber'
  return 'green'
}

function duePillLabel(dueDate) {
  if (!dueDate) return 'No date'
  const days = daysUntil(dueDate)
  if (days === -1) return 'Overdue'
  if (days < 0) return `Overdue · ${-days}d`
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days < 7) return parseLocalDate(dueDate).toLocaleDateString('en-IN', { weekday: 'short' })
  return parseLocalDate(dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

// The coming Monday, and a full week out when today already is one — "by
// Monday" said on a Monday means the next one, not this morning.
function nextMonday() {
  const today = todayISO()
  const dow = parseLocalDate(today).getDay() // Sun 0 … Sat 6
  return addDays(today, (8 - dow) % 7 || 7)
}

function duePresets() {
  const today = todayISO()
  const monday = nextMonday()
  return [
    { id: 'today', label: 'Today', date: today },
    { id: 'tomorrow', label: 'Tomorrow', date: addDays(today, 1) },
    { id: 'three', label: 'In 3 days', date: addDays(today, 3) },
    { id: 'monday', label: `By ${parseLocalDate(monday).toLocaleDateString('en-IN', { weekday: 'short' })}`, date: monday },
    { id: 'week', label: 'Next week', date: addDays(today, 7) },
  ]
}

function relativeAge(timestamp) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

function personName(person) {
  return person?.name || person?.email || 'Unknown'
}

function firstName(person) {
  return personName(person).trim().split(/\s+/)[0]
}

function initials(person) {
  const parts = personName(person).trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase()
}

function avatarHtml(person, size) {
  const label = personName(person)
  return `<span class="tb-avatar" style="background:${avatarColor(person?.id || label)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px" title="${esc(label)}">${esc(initials(person))}</span>`
}

// ---------------------------------------------------------------------------
// Composer auto-detection
// ---------------------------------------------------------------------------

// "@ruchir please chase the cheque" should land on Ruchir without touching a
// chip. Only an unambiguous match counts — two people whose names both start
// with the typed letters leaves the current pick alone rather than guessing —
// and the last mention wins, so correcting a half-typed name works.
function detectPerson(text, roster) {
  const mentions = [...String(text).matchAll(/@([A-Za-z][A-Za-z.'-]*)/g)].map(m => m[1].toLowerCase())
  for (let i = mentions.length - 1; i >= 0; i--) {
    const token = mentions[i]
    const hits = roster.filter(person =>
      personName(person).toLowerCase().split(/[\s@.]+/).filter(Boolean).some(part => part.startsWith(token))
    )
    if (hits.length === 1) return hits[0].id
  }
  return null
}

// Whichever card's vocabulary the text hits most often; ties fall to
// CARD_TYPES order. Only cards the viewer is allowed to FILE into are ever
// guessed — being able to see the Other stack is not licence to open one.
function detectType(text, composeTypes) {
  let best = null
  let bestScore = 0
  for (const type of CARD_TYPES) {
    if (!composeTypes.has(type.id)) continue
    const score = (String(text).match(TYPE_RE[type.id]) || []).length
    if (score > bestScore) {
      best = type.id
      bestScore = score
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Screen state
// ---------------------------------------------------------------------------
// One module-level object holding everything the mounted board needs, torn
// down by unmountTaskBoard(). `mountToken` guards the async gaps: a fetch that
// resolves after the user has navigated away — or re-entered the page — must
// not paint over whatever is on screen by then.

let ui = null
let channel = null
let reloadTimer = null
let suppressEditBlur = false
let outsideClickHandler = null
let viewportHandler = null
let popstateHandler = null
let sheetHistoryPushed = false
let toneTimer = null
let toastTimer = null
let mountToken = 0

export function unmountTaskBoard() {
  mountToken++
  clearTimeout(reloadTimer)
  clearTimeout(toastTimer)
  clearInterval(toneTimer)
  toneTimer = null
  reloadTimer = null
  toastTimer = null
  if (outsideClickHandler) {
    document.removeEventListener('mousedown', outsideClickHandler)
    document.removeEventListener('touchstart', outsideClickHandler)
    outsideClickHandler = null
  }
  if (viewportHandler && window.visualViewport) {
    window.visualViewport.removeEventListener('resize', viewportHandler)
    window.visualViewport.removeEventListener('scroll', viewportHandler)
    viewportHandler = null
  }
  if (popstateHandler) {
    window.removeEventListener('popstate', popstateHandler)
    popstateHandler = null
  }
  sheetHistoryPushed = false
  document.documentElement.style.removeProperty('--tb-keyboard')
  document.documentElement.style.removeProperty('--tb-viewport')
  if (channel) {
    supabase.removeChannel(channel)
    channel = null
  }
  ui = null
}

export async function renderTaskBoard(container) {
  unmountTaskBoard()
  const token = mountToken

  container.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="hamburgerBtn" aria-label="Menu">☰</button>
          <span class="logo-small">Task Board</span>
        </div>
      </header>
      <main class="app-main tb-main">
        <div class="tb-board" id="tbBoard">${skeletonList(3)}</div>
        <div class="tb-compose" id="tbCompose"></div>
      </main>
    </div>
  `

  const profile = await getCurrentProfile()
  if (token !== mountToken) return
  // isAdminProfile, not role alone: the database's can_use_card() and the
  // admin API both read is_admin, and this decides which cards and which
  // scopes are drawn — the two have to agree or the UI hides rows RLS is
  // happily returning.
  const isAdmin = isAdminProfile(profile)
  document.getElementById('hamburgerBtn').addEventListener('click', () => openSidebar({ isAdmin }))

  if (!profile) {
    document.getElementById('tbBoard').innerHTML = '<div class="empty-state">Could not load your profile.</div>'
    return
  }

  // The roster is the CRM's own user list, not a second list of names kept in
  // step by hand. Deactivated accounts are dropped entirely: they can still
  // show up as the `from` side of an older task, but nobody can be handed new
  // work on one.
  const [{ data: people, error: rosterError }, { data: access }] = await Promise.all([
    supabase.from('profiles').select('id, name, email, role, hide_from_roster').eq('active', true).order('name'),
    supabase.from('task_card_access').select('user_id, task_type'),
  ])
  if (token !== mountToken) return

  if (rosterError) {
    document.getElementById('tbBoard').innerHTML = `<div class="empty-state">Could not load the team: ${esc(rosterError.message)}</div>`
    return
  }

  const everyone = people || []
  ui = {
    me: profile.id,
    isAdmin,
    // Two lists, deliberately. `roster` is who can be PICKED — the composer's
    // person chips, the pass-on list and @mention detection all read it — and
    // it drops anyone flagged hide_from_roster.
    //
    // `rosterById` is who can be DISPLAYED and keeps everyone, hidden accounts
    // included. A hidden account can still file and pass on work, and the task
    // and history rows it left behind have to stay attributed to a name rather
    // than decaying into "Unknown" the moment someone is taken off the roster.
    roster: everyone.filter(person => !person.hide_from_roster),
    rosterById: Object.fromEntries(everyone.map(p => [p.id, p])),
    ...typeAccessFor(profile.id, access || [], isAdmin),
    tasks: [],
    error: null,
    historyByTask: {},
    openHistory: new Set(),
    openPicker: null,
    // Which row has its due picker open, and whether that picker has the
    // 15-day strip expanded. Only one row's picker is ever open, so these are
    // board state rather than something tracked per task.
    openDue: null,
    dueStripOpen: false,
    // Which row is being edited in place. Only ever one.
    editingTask: null,
    // Touch only: the one row currently expanded. Only ever one — a board
    // of open accordions is just the old always-on layout with extra taps.
    expandedTask: null,
    // Stacks default to open on a device that has never folded one.
    collapsedStacks: loadCollapsedStacks(),
    scope: 'in',
    compose: {
      personId: null,
      typeId: null,
      due: todayISO(),
      text: '',
      personTouched: false,
      typeTouched: false,
      stripOpen: false,
      sending: false,
      // Whether the chip panel is open. One flag for both layouts: on a
      // desktop it is a panel above the bar, on a phone the same state is
      // presented as a bottom sheet.
      panelOpen: false,
      missing: null,
    },
  }

  renderCompose()
  await loadTasks(token)
  if (token !== mountToken) return
  renderBoard()
  subscribe(token)
  startToneTicker(token)
}

// Two sets, because seeing a card and filing into one are separate questions.
//
// task_card_access answers both at once: a card with no rows there is open to
// everyone, a card with rows is restricted to exactly those users, and someone
// outside that list neither sees the stack nor gets the chip. RLS on
// team_tasks enforces that server-side regardless; dropping the stack here is
// only so a card the viewer can't use reads as absent rather than empty.
//
// `adminOnly` is the narrower one and answers the second question only. It
// keeps the composer chip away from non-admins, so they cannot open an Other
// task, while leaving the stack on their board — because a task an admin
// assigned to them is theirs to act on, and a card they can never see is a
// task they can never do.
//
// The task_card_access half assumes that table is readable in full by any
// signed-in user (it is config, not data). Under a policy returning only the
// viewer's OWN rows, a restricted card would look unrestricted to exactly the
// people locked out of it, and its stack would come back as the empty state
// this is meant to avoid.
function typeAccessFor(userId, accessRows, isAdmin) {
  const restricted = new Set(accessRows.map(row => row.task_type))
  const mine = new Set(accessRows.filter(row => row.user_id === userId).map(row => row.task_type))
  const permitted = CARD_TYPES.filter(type => !restricted.has(type.id) || mine.has(type.id))
  return {
    visibleTypes: new Set(permitted.map(type => type.id)),
    composeTypes: new Set(permitted.filter(type => !type.adminOnly || isAdmin).map(type => type.id)),
  }
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function loadTasks(token) {
  const { data, error } = await supabase
    .from('team_tasks')
    .select('*')
    .eq('status', 'open')
    .order('due_date', { ascending: true, nullsFirst: false })
  if (token !== mountToken || !ui) return
  ui.error = error ? error.message : null
  ui.tasks = error ? [] : (data || [])
  // Anything whose history is expanded gets re-read in the same pass, so a
  // pass-on made on someone else's screen lands in an already-open panel too.
  if (!error && ui.openHistory.size) {
    await Promise.all([...ui.openHistory].map(id => loadHistory(id, token)))
  }
}

async function loadHistory(taskId, token) {
  const { data } = await supabase
    .from('team_task_history')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true })
  if (token !== mountToken || !ui) return
  ui.historyByTask[taskId] = data || []
}

// Realtime carries no payload worth trusting here — an UPDATE that moves a
// task out of the viewer's RLS visibility arrives as a DELETE, and a row filed
// by someone else arrives without its history — so every event just re-reads
// the board. Coalesced, because filing one task fires two of them.
// A task due tomorrow is due today once midnight passes, and nobody is going
// to reload at 00:00 to find out. Checked every minute, repainted only when a
// band actually changed, and never while something is open on top of a row.
function startToneTicker(token) {
  clearInterval(toneTimer)
  toneTimer = setInterval(() => {
    if (token !== mountToken || !ui) return
    if (ui.editingTask || ui.openDue || ui.openPicker) return
    if (toneSignature() === ui.toneSignature) return
    renderBoard()
  }, 60000)
}

function toneSignature() {
  return ui.tasks.map(task => task.id + dueTone(task.due_date)).join('|')
}

function subscribe(token) {
  const onChange = () => {
    if (token !== mountToken) return
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(async () => {
      await loadTasks(token)
      if (token !== mountToken) return
      renderBoard()
      refreshNavBadges()
    }, 180)
  }

  channel = supabase
    .channel('task-board')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'team_tasks' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'team_task_history' }, onChange)
    .subscribe()
}

// ---------------------------------------------------------------------------
// Board rendering
// ---------------------------------------------------------------------------

function visibleScopes() {
  return SCOPES.filter(scope => !scope.adminOnly || ui.isAdmin)
}

function scopedTasks() {
  const { tasks, scope, me } = ui
  // 'all' is every row the query returned, which for an admin is the whole
  // team's board — the policies already let them read it, this just stops
  // filtering it down to rows they are personally part of. Guarded on
  // isAdmin so a stale scope cannot survive a change in who is signed in.
  if (scope === 'all' && ui.isAdmin) return tasks
  if (scope === 'to-me') return tasks.filter(t => t.assigned_to === me)
  if (scope === 'by-me') return tasks.filter(t => t.created_by === me)
  return tasks.filter(t => t.assigned_to === me || t.created_by === me)
}

function renderBoard() {
  const el = document.getElementById('tbBoard')
  if (!el || !ui) return

  if (ui.error) {
    el.innerHTML = `<div class="empty-state">Could not load the board: ${esc(ui.error)}</div>`
    return
  }

  const visible = scopedTasks()
  // A repaint mid-edit (realtime, or another row being acted on) must not
  // throw away what is being typed, so the in-progress value is carried
  // across and the caret put back at the end.
  const draft = el.querySelector('.tb-task-edit')?.value
  suppressEditBlur = true
  el.innerHTML = headHtml(visible) + kpiHtml(visible) + gridHtml(visible)
  suppressEditBlur = false
  wireBoard(el)

  ui.toneSignature = toneSignature()

  const editing = el.querySelector('.tb-task-edit')
  if (editing) {
    if (draft !== undefined) editing.value = draft
    editing.focus()
    editing.setSelectionRange(editing.value.length, editing.value.length)
  }
}

function headHtml(visible) {
  const overdue = visible.filter(t => daysUntil(t.due_date) < 0).length
  // Per-person counts deliberately ignore the scope toggle: they answer "who
  // is carrying what right now", which shouldn't change because the viewer
  // narrowed their own view.
  const counts = ui.roster.map(person => {
    const open = ui.tasks.filter(t => t.assigned_to === person.id).length
    return `
      <span class="tb-person${open ? '' : ' tb-person-idle'}" title="${esc(personName(person))} · ${open} open">
        ${avatarHtml(person, 26)}
        <span class="tb-person-n">${open}</span>
      </span>
    `
  }).join('')

  return `
    <div class="tb-head">
      <div class="tb-head-title">
        <div class="tb-title">Task Board</div>
        <div class="tb-sub">${visible.length} open in this view${overdue ? ` · ${overdue} overdue` : ''}</div>
      </div>
      <div class="tb-scopes" role="tablist">
        ${visibleScopes().map(scope => `
          <button type="button" class="tb-scope${scope.id === ui.scope ? ' active' : ''}" data-scope="${scope.id}" role="tab" aria-selected="${scope.id === ui.scope}">${esc(scope.label)}</button>
        `).join('')}
      </div>
      <div class="tb-people">${counts}</div>
    </div>
  `
}

function kpiHtml(visible) {
  return `
    <div class="tb-kpis">
      ${KPIS.map(kpi => {
        const count = visible.filter(t => kpi.test(daysUntil(t.due_date))).length
        return `
          <div class="tb-kpi tb-tone-${kpi.tone}">
            <span class="tb-kpi-icon">${icon(kpi.icon, 15)}</span>
            <span class="tb-kpi-text">
              <span class="tb-kpi-value">${count}</span>
              <span class="tb-kpi-label">${esc(kpi.label)}</span>
            </span>
          </div>
        `
      }).join('')}
    </div>
  `
}

function gridHtml(visible) {
  const stacks = CARD_TYPES
    .filter(type => ui.visibleTypes.has(type.id))
    .map(type => stackHtml(type, visible.filter(t => t.task_type === type.id)))
    .join('')
  return `<div class="tb-grid">${stacks}</div>`
}

function stackHtml(type, tasks) {
  // Ascending by due date with undated tasks last — daysUntil() already
  // reports those as Infinity, so one comparator covers both.
  const sorted = [...tasks].sort((a, b) => daysUntil(a.due_date) - daysUntil(b.due_date))
  const body = sorted.length
    ? sorted.map(taskHtml).join('')
    : '<div class="tb-stack-empty">Nothing pending here.</div>'

  // The count sits outside .tb-stack-body on purpose: folded, the header is
  // all you can see, and it still has to tell you how much is in there.
  const collapsed = ui.collapsedStacks.has(type.id)
  return `
    <section class="tb-stack${collapsed ? ' collapsed' : ''}">
      <button type="button" class="tb-stack-head" data-stack="${esc(type.id)}" aria-expanded="${!collapsed}">
        <span class="tb-stack-icon">${icon(type.icon, 14)}</span>
        <span class="tb-stack-label">${esc(type.label)}</span>
        <span class="tb-stack-count">${sorted.length}</span>
        <span class="tb-stack-chevron">${icon('chevron-down', 16)}</span>
      </button>
      <div class="tb-stack-body">${body}</div>
    </section>
  `
}

// The two people the task is actually between. An admin reading the whole
// board in 'all' is not one of them and does not get to rewrite someone
// else's task — seeing every row is not the same as owning every row.
function canEditTask(task) {
  return task.created_by === ui.me || task.assigned_to === ui.me
}

function taskHtml(task) {
  const from = ui.rosterById[task.created_by]
  const to = ui.rosterById[task.assigned_to]
  const tone = dueTone(task.due_date)
  const historyOpen = ui.openHistory.has(task.id)
  const pickerOpen = ui.openPicker === task.id

  // At rest the row is only the task and its due tag: the fill already says
  // how urgent it is, so the dot that used to sit at the start is gone, and
  // the meta and the three buttons are lifted out of the flow entirely.
  // They float over the right-hand side on hover instead, which is what lets
  // a long task name use the whole row until someone actually reaches for it.
  return `
    <article class="tb-task tb-tone-${tone}${ui.expandedTask === task.id ? " expanded" : ""}" data-task="${esc(task.id)}">
      <div class="tb-task-row">
        <div class="tb-task-main">
          ${ui.editingTask === task.id
            ? `<textarea class="tb-task-edit" rows="1" aria-label="Task text">${esc(task.body)}</textarea>`
            : `<div class="tb-task-text"${canEditTask(task) ? ' data-act="edit-text"' : ''} title="${esc(task.body)}">${esc(task.body)}</div>`}
        </div>
        <div class="tb-task-right">
          <div class="tb-task-float">
            <span class="tb-task-meta">
              ${avatarHtml(from, 16)}
              <span class="tb-arrow" aria-hidden="true">${icon("arrow-right", 10)}</span>
              ${avatarHtml(to, 16)}
              <span class="tb-sr">From ${esc(personName(from))} to ${esc(personName(to))}.</span>
              <span class="tb-task-age">${esc(relativeAge(task.created_at))}</span>
            </span>
            <div class="tb-task-actions">
              <button type="button" class="tb-btn" data-act="history" aria-expanded="${historyOpen}">${icon("history", 13)}<span class="tb-btn-text">History</span></button>
              <button type="button" class="tb-btn" data-act="pass" aria-expanded="${pickerOpen}">${icon("send", 13)}<span class="tb-btn-text">Pass on</span></button>
              <button type="button" class="tb-btn tb-btn-done" data-act="done">${icon("check", 13)}<span class="tb-btn-text">Done</span></button>
            </div>
          </div>
          <button type="button" class="tb-due" data-act="due" aria-expanded="${ui.openDue === task.id}" title="Change the due date">${esc(duePillLabel(task.due_date))}</button>
        </div>
      </div>
      <div class="tb-task-expand">
        <div class="tb-task-expand-inner">
          <span class="tb-task-meta">
            ${avatarHtml(from, 16)}
            <span class="tb-arrow" aria-hidden="true">${icon("arrow-right", 10)}</span>
            ${avatarHtml(to, 16)}
            <span class="tb-sr">From ${esc(personName(from))} to ${esc(personName(to))}.</span>
            <span class="tb-task-age">${esc(relativeAge(task.created_at))}</span>
          </span>
          <div class="tb-task-actions">
            <button type="button" class="tb-btn" data-act="history">${icon("history", 14)}<span class="tb-btn-text">History</span></button>
            <button type="button" class="tb-btn" data-act="pass">${icon("send", 14)}<span class="tb-btn-text">Pass on</span></button>
            <button type="button" class="tb-btn tb-btn-done" data-act="done">${icon("check", 14)}<span class="tb-btn-text">Done</span></button>
          </div>
        </div>
      </div>
      ${ui.openDue === task.id ? duePickerHtml(task) : ''}
      ${pickerOpen ? passPickerHtml(task) : ''}
      ${historyOpen ? historyHtml(task) : ''}
    </article>
  `
}
// The same date choices the composer offers, opened in place from the row's
// own due pill rather than a dialog. Not shared markup with the composer:
// that one is rendered once and mutated by hand to protect a half-typed
// message, while this is rebuilt from ui state on every board paint like the
// rest of the row.
function duePickerHtml(task) {
  const today = todayISO()
  return `
    <div class="tb-panel tb-duepicker">
      <span class="tb-panel-label">Due</span>
      ${duePresets().map(preset => `
        <button type="button" class="tb-chip tb-chip-due${preset.date === task.due_date ? ' active' : ''}" data-due-set="${esc(preset.date)}" title="${esc(parseLocalDate(preset.date).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }))}">${esc(preset.label)}</button>
      `).join('')}
      <button type="button" class="tb-chip tb-chip-strip${ui.dueStripOpen ? ' active' : ''}" data-due-strip="1" aria-expanded="${ui.dueStripOpen}">${icon('calendar', 13)}<span>Pick a day</span></button>
      <div class="tb-strip tb-strip-inline"${ui.dueStripOpen ? '' : ' hidden'}>
        ${Array.from({ length: DAY_STRIP_LENGTH }, (_, offset) => {
          const date = addDays(today, offset)
          const day = parseLocalDate(date)
          // Each day carries its own tone class, so the coloured edge shows
          // what that date WOULD make the task rather than inheriting the
          // colour the task happens to be now.
          return `
            <button type="button" class="tb-day tb-tone-${dueTone(date)}${date === task.due_date ? ' active' : ''}" data-due-set="${esc(date)}">
              <span class="tb-day-dow">${esc(day.toLocaleDateString('en-IN', { weekday: 'short' }))}</span>
              <span class="tb-day-num">${day.getDate()}</span>
            </button>
          `
        }).join('')}
      </div>
    </div>
  `
}

function passPickerHtml(task) {
  const options = ui.roster.filter(person => person.id !== task.assigned_to)
  if (!options.length) return '<div class="tb-panel tb-panel-empty">Nobody else to pass this to.</div>'
  return `
    <div class="tb-panel tb-picker">
      <span class="tb-panel-label">Pass on to</span>
      ${options.map(person => {
        // Handing it back to whoever filed it is the same write as any other
        // pass — only the label and the history verb differ.
        const back = person.id === task.created_by
        return `
          <button type="button" class="tb-pick" data-pick="${esc(person.id)}">
            ${avatarHtml(person, 20)}
            <span>${back ? `Back to ${esc(firstName(person))}` : esc(personName(person))}</span>
          </button>
        `
      }).join('')}
    </div>
  `
}

function historyHtml(task) {
  const rows = ui.historyByTask[task.id]
  if (!rows) return '<div class="tb-panel tb-panel-empty">Loading history…</div>'
  if (!rows.length) return '<div class="tb-panel tb-panel-empty">No history recorded for this task.</div>'
  return `
    <div class="tb-panel tb-history">
      ${rows.map(row => {
        const actor = ui.rosterById[row.actor]
        const target = row.to_user ? ui.rosterById[row.to_user] : null
        const verb = HISTORY_VERBS[row.action] || row.action
        return `
          <div class="tb-history-row">
            ${avatarHtml(actor, 18)}
            <span class="tb-history-text"><strong>${esc(firstName(actor))}</strong> ${esc(verb)}${target ? ` <strong>${esc(firstName(target))}</strong>` : ''}</span>
            <span class="tb-history-when">${esc(relativeAge(row.created_at))}</span>
          </div>
        `
      }).join('')}
    </div>
  `
}

function wireBoard(root) {
  root.querySelectorAll('.tb-stack-head[data-stack]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.stack
      if (ui.collapsedStacks.has(id)) ui.collapsedStacks.delete(id)
      else ui.collapsedStacks.add(id)
      saveCollapsedStacks(ui.collapsedStacks)
      renderBoard()
    })
  })

  root.querySelectorAll('.tb-scope').forEach(btn => {
    btn.addEventListener('click', () => {
      ui.scope = btn.dataset.scope
      renderBoard()
    })
  })

  root.querySelectorAll('.tb-task').forEach(article => {
    const taskId = article.dataset.task
    const task = ui.tasks.find(t => String(t.id) === taskId)
    if (!task) return

    article.querySelector('[data-act="edit-text"]')?.addEventListener('dblclick', () => {
      ui.editingTask = task.id
      renderBoard()
    })
    const editInput = article.querySelector('.tb-task-edit')
    if (editInput) {
      // Grow to the text rather than scrolling inside a fixed box, so editing
      // shows as much as reading did.
      const autosize = () => {
        editInput.style.height = 'auto'
        editInput.style.height = editInput.scrollHeight + 'px'
      }
      autosize()
      editInput.addEventListener('input', autosize)
      editInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); saveTaskText(task, editInput.value) }
        else if (event.key === 'Escape') { event.preventDefault(); ui.editingTask = null; renderBoard() }
      })
      // Blur means save, except when the input is being torn out from under
      // the user by a repaint (a realtime event, or the Escape above). That
      // is not them clicking away, and treating it as one would commit a
      // half-typed line or re-save the old one.
      editInput.addEventListener('blur', () => {
        if (suppressEditBlur || ui.editingTask !== task.id) return
        saveTaskText(task, editInput.value)
      })
    }

    // Two copies of each action exist — the one that floats on hover and the
    // one inside the tap-out panel — and only one is ever displayed. Wiring
    // both means neither presentation needs to know the other is there.
    article.querySelectorAll('[data-act="history"]').forEach(b => b.addEventListener('click', () => toggleHistory(task)))
    // Pass-on and due are both "change this task" pickers, so opening one
    // closes the other rather than stacking two panels under one row.
    article.querySelectorAll('[data-act="pass"]').forEach(b => b.addEventListener('click', () => {
      const opening = ui.openPicker !== task.id
      ui.openPicker = opening ? task.id : null
      if (opening) ui.openDue = null
      renderBoard()
    }))
    // Tap anywhere on the row that is not itself a control: opens this row
    // and closes whichever was open. Hover devices ignore it entirely.
    article.querySelector('.tb-task-row')?.addEventListener('click', event => {
      if (!isTouchLayout()) return
      if (event.target.closest('button, input, a, label')) return
      ui.expandedTask = ui.expandedTask === task.id ? null : task.id
      renderBoard()
    })

    article.querySelector('[data-act="due"]')?.addEventListener('click', () => {
      const opening = ui.openDue !== task.id
      ui.openDue = opening ? task.id : null
      ui.dueStripOpen = false
      if (opening) ui.openPicker = null
      renderBoard()
    })
    article.querySelector('[data-due-strip]')?.addEventListener('click', () => {
      ui.dueStripOpen = !ui.dueStripOpen
      renderBoard()
    })
    article.querySelectorAll('[data-due-set]').forEach(btn => {
      btn.addEventListener('click', () => changeDue(task, btn.dataset.dueSet, btn))
    })
    article.querySelectorAll('[data-act="done"]').forEach(b => b.addEventListener('click', event => markDone(task, event.currentTarget)))
    article.querySelectorAll('.tb-pick').forEach(btn => {
      btn.addEventListener('click', () => passOn(task, btn.dataset.pick, btn))
    })
  })
}

// ---------------------------------------------------------------------------
// Task actions
// ---------------------------------------------------------------------------

// The history row is written after the change it describes, never instead of
// it, so a failure here leaves a real task in a real state with a gap in its
// trail — worth saying out loud rather than swallowing, but not worth undoing
// the move. `to_user` is left off entirely when the action has no target
// (marking something done), rather than sent as an explicit null.
async function recordHistory(taskId, action, toUserId) {
  const row = { task_id: taskId, actor: ui.me, action }
  if (toUserId) row.to_user = toUserId
  // The id comes back so markDone can hand it to Undo — a task that was
  // un-done should not leave a trail claiming it was completed.
  const { data, error } = await supabase.from('team_task_history').insert(row).select('id').maybeSingle()
  if (error) { console.error('Task history not recorded:', error.message); return null }
  return data?.id ?? true
}

async function toggleHistory(task) {
  if (ui.openHistory.has(task.id)) {
    ui.openHistory.delete(task.id)
    renderBoard()
    return
  }
  ui.openHistory.add(task.id)
  renderBoard() // paints the "Loading history…" panel straight away
  const token = mountToken
  await loadHistory(task.id, token)
  if (token !== mountToken) return
  renderBoard()
}

async function passOn(task, toUserId, button) {
  if (!ui || button.disabled) return
  button.disabled = true
  const token = mountToken
  // 'sent_back' when it's going home to whoever filed it, 'passed' otherwise —
  // the same write either way, the distinction is only for the history trail.
  const action = toUserId === task.created_by ? 'sent_back' : 'passed'

  const { error } = await supabase.from('team_tasks').update({ assigned_to: toUserId }).eq('id', task.id)
  if (error) {
    button.disabled = false
    toast(`Could not pass it on: ${error.message}`)
    return
  }
  const logged = await recordHistory(task.id, action, toUserId)
  if (token !== mountToken) return

  ui.openPicker = null
  const target = ui.rosterById[toUserId]
  const moved = action === 'sent_back' ? `Sent back to ${firstName(target)}` : `Passed on to ${firstName(target)}`
  toast(logged ? moved : `${moved} — but the history entry failed to save`)
  await refresh(token)
}

// Open to anyone the task is visible to, not just whoever filed it — the
// person carrying the work is usually the one who knows the date has moved.
// Nothing here narrows that; RLS on team_tasks decides who may write, exactly
// as it does for the pass-on and done updates beside this.
// Empty is treated as a cancel rather than a save: blanking the one line
// that says what the task IS would leave a coloured row with nothing on
// it, and that is far more likely a slip than an intention.
async function saveTaskText(task, rawValue) {
  if (!ui || ui.editingTask !== task.id) return
  const body = String(rawValue).trim()
  ui.editingTask = null

  if (!body || body === task.body) { renderBoard(); return }

  const token = mountToken
  const { error } = await supabase.from('team_tasks').update({ body }).eq('id', task.id)
  if (error) {
    toast(`Could not save the change: ${error.message}`)
    renderBoard()
    return
  }
  if (token !== mountToken) return

  // Repaint off the local row first so the new text, and its position in
  // the stack, land on the keystroke rather than after the re-read.
  task.body = body
  renderBoard()

  const logged = await recordHistory(task.id, 'edited', null)
  if (token !== mountToken) return
  toast(logged ? 'Task updated' : 'Task updated — but the history entry failed to save')
  await refresh(token)
}

async function changeDue(task, date, button) {
  if (!ui || button.disabled) return
  if (date === task.due_date) { // already on this date — just close the picker
    ui.openDue = null
    ui.dueStripOpen = false
    renderBoard()
    return
  }
  button.disabled = true
  const token = mountToken

  const { error } = await supabase.from('team_tasks').update({ due_date: date }).eq('id', task.id)
  if (error) {
    button.disabled = false
    toast(`Could not change the due date: ${error.message}`)
    return
  }
  if (token !== mountToken) return

  // Repaint off the local row before the re-read comes back: the write has
  // already succeeded, and the colour, the pill and the task's position in
  // its stack should land the moment the date is picked.
  task.due_date = date
  ui.openDue = null
  ui.dueStripOpen = false
  renderBoard()

  // No target user: like 'done', this action changes the task without moving
  // it, so to_user stays off the row entirely.
  const logged = await recordHistory(task.id, 'due_changed', null)
  if (token !== mountToken) return

  const when = parseLocalDate(date).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
  toast(logged ? `Due ${when}` : `Due ${when} — but the history entry failed to save`)
  await refresh(token)
}

async function markDone(task, button) {
  if (!ui || button.disabled) return
  button.disabled = true
  const token = mountToken

  const { error } = await supabase
    .from('team_tasks')
    .update({ status: 'done', done_at: new Date().toISOString() })
    .eq('id', task.id)
  if (error) {
    button.disabled = false
    toast(`Could not close it: ${error.message}`)
    return
  }
  const historyId = await recordHistory(task.id, 'done', null)
  if (token !== mountToken) return

  // The board only ever queries status = 'open', so it drops out on reload.
  ui.openHistory.delete(task.id)
  if (ui.openPicker === task.id) ui.openPicker = null
  if (ui.openDue === task.id) { ui.openDue = null; ui.dueStripOpen = false }
  // Five seconds with a way back. Done sits inches from Pass on and the
  // wrong row is an easy click, so the undo is the point, not a courtesy.
  toast(historyId ? 'Marked done' : 'Marked done — but the history entry failed to save', {
    actionLabel: 'Undo',
    onAction: () => undoDone(task, historyId),
    duration: 5000,
  })
  await refresh(token)
}

async function undoDone(task, historyId) {
  if (!ui) return
  const token = mountToken
  const { error } = await supabase.from('team_tasks').update({ status: 'open', done_at: null }).eq('id', task.id)
  if (error) { toast(`Could not undo: ${error.message}`); return }
  // Best effort: if the delete policy will not allow it the task still comes
  // back, it just keeps a "marked done" line in its history.
  if (historyId && historyId !== true) await supabase.from('team_task_history').delete().eq('id', historyId)
  if (token !== mountToken) return
  toast('Brought back')
  await refresh(token)
}

async function refresh(token) {
  await loadTasks(token)
  if (token !== mountToken) return
  renderBoard()
  refreshNavBadges()
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------
// Rendered exactly once. Every later change — a chip lighting up, the Assign
// button enabling, the day strip opening — is painted onto the existing nodes
// by syncCompose(), because re-rendering this bar would throw away the
// half-typed message and the caret along with it.

// Every date the composer offers is relative to "today", so this block is the
// one part of the bar that goes stale on its own: a board left open on a shop
// screen overnight would still be offering yesterday under a chip labelled
// Today. syncCompose() re-stamps it when the date rolls over.
function dueRowsHtml() {
  const today = todayISO()
  return `
    <div class="tb-chiprow" data-row="due" role="radiogroup" aria-label="Due">
      <span class="tb-chiprow-label">Due</span>
      <div class="tb-chiprow-scroll">
      ${duePresets().map(preset => `
        <button type="button" class="tb-chip tb-chip-due" data-due="${esc(preset.date)}" title="${esc(parseLocalDate(preset.date).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }))}">${esc(preset.label)}</button>
      `).join('')}
      <button type="button" class="tb-chip tb-chip-strip" id="tbStripToggle" aria-expanded="false">${icon('calendar', 13)}<span>Pick a day</span></button>
      </div>
      <input type="date" class="tb-date-native" id="tbDateNative" tabindex="-1" aria-hidden="true" />
    </div>

    <div class="tb-strip" id="tbStrip" hidden>
      ${Array.from({ length: DAY_STRIP_LENGTH }, (_, offset) => {
        const date = addDays(today, offset)
        const day = parseLocalDate(date)
        return `
          <button type="button" class="tb-day tb-tone-${dueTone(date)}" data-due="${esc(date)}">
            <span class="tb-day-dow">${esc(day.toLocaleDateString('en-IN', { weekday: 'short' }))}</span>
            <span class="tb-day-num">${day.getDate()}</span>
          </button>
        `
      }).join('')}
    </div>
  `
}

// Wires the due presets, the day strip and the strip toggle. Split out because
// dueRowsHtml() is re-rendered on a date rollover and its buttons are new
// nodes by then, with no handlers on them.
function wireDueRows() {
  const rows = document.getElementById('tbDueRows')
  if (!rows) return
  rows.querySelectorAll('.tb-chip-due, .tb-day').forEach(chip => {
    chip.addEventListener('click', () => {
      ui.compose.due = chip.dataset.due
      syncCompose()
    })
  })
  document.getElementById('tbStripToggle').addEventListener('click', () => {
    // A 15-day strip is a desktop affordance. A phone already has a date
    // picker that everyone knows how to use, so hand off to it.
    if (isPhoneLayout()) { openNativeDate(); return }
    ui.compose.stripOpen = !ui.compose.stripOpen
    syncCompose()
  })

  const native = document.getElementById('tbDateNative')
  if (native) {
    native.addEventListener('change', () => {
      if (!native.value) return
      ui.compose.due = native.value
      syncCompose()
    })
  }
}

// Short label for the Due selector button and the summary line: the name of
// the day when that is the clearest thing to say, a date once 'next Thursday'
// stops being unambiguous.
function dueShortLabel(dueDate) {
  if (!dueDate) return "No date"
  const days = daysUntil(dueDate)
  if (days === 0) return "Today"
  if (days === 1) return "Tomorrow"
  if (days > 1 && days < 7) return parseLocalDate(dueDate).toLocaleDateString("en-IN", { weekday: "short" })
  return parseLocalDate(dueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
}

// The card a task lands in when nobody picked one. The spec says Other
// Tasks, but only an admin can file one — so for everyone else there is no
// safe default and a type stays required, which is what canSubmit() below
// reflects. Note this reads the filing set, not the visible one: a non-admin
// can see the Other stack now, and defaulting them into a card they are not
// allowed to open would only fail again at the database.
function defaultTypeId() {
  return ui.composeTypes.has("other") ? "other" : null
}

function effectiveTypeId() {
  return ui.compose.typeId || defaultTypeId()
}
function renderCompose() {
  const el = document.getElementById("tbCompose")
  if (!el || !ui) return

  const types = CARD_TYPES.filter(type => ui.composeTypes.has(type.id))
  ui.composeDay = todayISO()

  el.innerHTML = `
    <div class="tb-compose-rows" id="tbComposeRows">
      <button type="button" class="tb-sheet-handle" id="tbSheetHandle" aria-label="Close the assign sheet"></button>

      <div class="tb-assignpanel-wrap" id="tbPanelWrap">
        <div class="tb-assignpanel-clip">
          <div class="tb-assignpanel" id="tbPanel">
            <div class="tb-chiprow" data-row="person" role="radiogroup" aria-label="Assign to">
              <span class="tb-chiprow-label">Assign to</span>
              <div class="tb-chiprow-scroll">
              ${ui.roster.map(person => `
                <button type="button" class="tb-chip tb-chip-person" role="radio" aria-checked="false" tabindex="-1" data-person="${esc(person.id)}" title="${esc(personName(person))}">
                  ${avatarHtml(person, 20)}
                  <span>${person.id === ui.me ? "Me" : esc(firstName(person))}</span>
                </button>
              `).join("")}
              </div>
            </div>

            <div class="tb-chiprow" data-row="type" role="radiogroup" aria-label="Type">
              <span class="tb-chiprow-label">Type</span>
              <div class="tb-chiprow-scroll">
              ${types.map(type => `
                <button type="button" class="tb-chip tb-chip-type" role="radio" aria-checked="false" tabindex="-1" data-type="${esc(type.id)}">
                  ${icon(type.icon, 13)}<span class="tb-chip-full">${esc(type.label)}</span><span class="tb-chip-short">${esc(type.short)}</span>
                </button>
              `).join("")}
              </div>
            </div>

            <div id="tbDueRows">${dueRowsHtml()}</div>
          </div>
        </div>
      </div>

      <div class="tb-barrow">
        <button type="button" class="tb-plus" id="tbPlus" aria-label="Open the assign panel" aria-expanded="false" aria-controls="tbPanel">${icon("plus", 18)}</button>
        <input type="text" class="tb-input" id="tbInput" autocomplete="off"
               placeholder="What needs doing? Type @name to pick a person." />
        <button type="button" class="tb-sel" id="tbSelPerson" data-row="person" aria-expanded="false" aria-controls="tbPanel">
          <span class="tb-sel-icon">${icon("user", 15)}</span><span class="tb-sel-label">Assign to</span>${icon("chevron-down", 13)}
        </button>
        <button type="button" class="tb-sel" id="tbSelType" data-row="type" aria-expanded="false" aria-controls="tbPanel">
          <span class="tb-sel-icon">${icon("layers", 15)}</span><span class="tb-sel-label">Type</span>${icon("chevron-down", 13)}
        </button>
        <button type="button" class="tb-sel" id="tbSelDue" data-row="due" aria-expanded="false" aria-controls="tbPanel">
          <span class="tb-sel-icon">${icon("calendar", 15)}</span><span class="tb-sel-label">Today</span>${icon("chevron-down", 13)}
        </button>
        <button type="button" class="btn tb-assign" id="tbAssign" aria-label="Assign" disabled>
          <span class="tb-assign-icon" aria-hidden="true">${icon("send", 17)}</span><span class="tb-assign-text">Assign</span>
        </button>
      </div>

      <div class="tb-summary">
        <span class="tb-summary-pills" id="tbSummaryPills"></span>
        <span class="tb-summary-text" id="tbSummary"></span>
        <span class="tb-summary-hint">Enter to assign · Esc to close</span>
      </div>
    </div>
  `

  el.querySelectorAll(".tb-chip-person").forEach(chip => {
    chip.addEventListener("click", () => {
      ui.compose.personId = ui.compose.personId === chip.dataset.person ? null : chip.dataset.person
      ui.compose.personTouched = true // a tap is a decision; stop guessing
      syncCompose()
    })
  })

  el.querySelectorAll(".tb-chip-type").forEach(chip => {
    chip.addEventListener("click", () => {
      ui.compose.typeId = ui.compose.typeId === chip.dataset.type ? null : chip.dataset.type
      ui.compose.typeTouched = true
      syncCompose()
    })
  })

  wireDueRows()
  wireRadioKeys(el)

  const input = document.getElementById("tbInput")
  input.addEventListener("input", () => {
    ui.compose.text = input.value
    if (!ui.compose.personTouched) {
      const guess = detectPerson(input.value, ui.roster)
      if (guess) ui.compose.personId = guess
    }
    if (!ui.compose.typeTouched) {
      const guess = detectType(input.value, ui.composeTypes)
      if (guess) ui.compose.typeId = guess
    }
    syncCompose()
  })
  input.addEventListener("focus", () => { setPanelOpen(true); resyncKeyboardSoon() })
  input.addEventListener("blur", () => resyncKeyboardSoon())
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      // Enter with nothing to send is not a no-op: say which piece is
      // missing and point at the row that fixes it, rather than leaving a
      // dead key and a disabled button to explain themselves.
      if (!canSubmit()) { flashMissing(); return }
      submitTask()
    } else if (event.key === "Escape") {
      event.preventDefault()
      setPanelOpen(false)
    }
  })

  document.getElementById("tbAssign").addEventListener("click", () => {
    if (!canSubmit()) { flashMissing(); return }
    submitTask()
  })

  // The selector buttons are a way into the panel, not menus of their own —
  // they open it and light up the row that answers them.
  document.getElementById("tbPlus").addEventListener("click", () => setPanelOpen(!ui.compose.panelOpen))
  el.querySelectorAll(".tb-sel").forEach(button => {
    button.addEventListener("click", () => {
      setPanelOpen(true)
      flashRow(button.dataset.row)
    })
  })

  // Clicking off the bar puts it away but keeps everything typed and chosen.
  outsideClickHandler = event => {
    if (!ui || !ui.compose.panelOpen) return
    const bar = document.getElementById("tbCompose")
    if (bar && !bar.contains(event.target)) setPanelOpen(false)
  }
  document.addEventListener('mousedown', outsideClickHandler)
  document.addEventListener('touchstart', outsideClickHandler, { passive: true })

  wireSheet()

  syncCompose()
}

// Arrow keys walk a chip row; Space/Enter picks. Roving tabindex, so the
// row is one tab stop rather than eleven.
function openNativeDate() {
  const native = document.getElementById('tbDateNative')
  if (!native) return
  native.value = ui.compose.due || todayISO()
  native.min = todayISO()
  // showPicker is the supported way to open it without the input being a
  // visible control; the click is the fallback where it is missing.
  try { native.showPicker() } catch { native.click() }
}

function wireRadioKeys(root) {
  root.querySelectorAll('[role="radiogroup"]').forEach(group => {
    group.addEventListener("keydown", event => {
      const chips = [...group.querySelectorAll('[role="radio"]')]
      const here = chips.indexOf(document.activeElement)
      if (here < 0) return
      let next = null
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (here + 1) % chips.length
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (here - 1 + chips.length) % chips.length
      else if (event.key === "Home") next = 0
      else if (event.key === "End") next = chips.length - 1
      else if (event.key === " " || event.key === "Enter") { event.preventDefault(); chips[here].click(); return }
      else return
      event.preventDefault()
      chips[next].focus()
    })
  })
}

// Open/shut is a class, never a re-render — the bar is holding a half-typed
// message. The panel is absolutely positioned above the bar so growing it
// cannot push the board around underneath.
// The sheet has to sit ON the keyboard, not behind it. visualViewport is the
// only thing that actually knows how tall the keyboard is; innerHeight does
// not change when it opens on iOS.
function syncKeyboardInset() {
  const root = document.documentElement
  const vv = window.visualViewport
  if (!vv) {
    // No visualViewport: there is no way to know a keyboard is up, so publish
    // the honest answer rather than a stale one.
    root.style.setProperty('--tb-keyboard', '0px')
    root.style.setProperty('--tb-viewport', root.clientHeight + 'px')
    return
  }
  // clientHeight, not innerHeight: innerHeight tracks the pinch-zoom visual
  // viewport on some Android builds, which would read a zoomed-out page as a
  // keyboard and lift the bar off the bottom of the screen.
  const layout = root.clientHeight
  // How much of the layout viewport the keyboard is covering. On Android the
  // layout viewport itself shrinks, so this is 0 and bottom: 0 is already
  // right; on iOS only the visual viewport moves, so this is the keyboard.
  const inset = Math.max(0, Math.round(layout - vv.height - vv.offsetTop))
  root.style.setProperty('--tb-keyboard', inset + 'px')
  // What is actually on screen. The sheet is capped to this so that a tall
  // sheet plus a keyboard cannot push the input off the top.
  root.style.setProperty('--tb-viewport', Math.round(vv.height) + 'px')
}

// The keyboard does not always announce itself on the way out — iOS in
// particular can settle a frame or two after blur — so a dismissal is
// re-read a couple of times rather than trusted first time. Without this the
// inset can stay behind as a strip of blank space under the bar.
function resyncKeyboardSoon() {
  syncKeyboardInset()
  requestAnimationFrame(syncKeyboardInset)
  setTimeout(syncKeyboardInset, 120)
  setTimeout(syncKeyboardInset, 400)
}

function wireSheet() {
  const handle = document.getElementById('tbSheetHandle')
  if (handle) {
    handle.addEventListener('click', () => setPanelOpen(false))
    // Swipe the handle down to dismiss — the gesture the sheet looks like it
    // should have.
    let startY = null
    handle.addEventListener('touchstart', e => { startY = e.touches[0].clientY }, { passive: true })
    handle.addEventListener('touchmove', e => {
      if (startY === null) return
      if (e.touches[0].clientY - startY > 40) { startY = null; setPanelOpen(false) }
    }, { passive: true })
    handle.addEventListener('touchend', () => { startY = null }, { passive: true })
  }

  if (window.visualViewport && !viewportHandler) {
    viewportHandler = () => syncKeyboardInset()
    window.visualViewport.addEventListener('resize', viewportHandler)
    window.visualViewport.addEventListener('scroll', viewportHandler)
    syncKeyboardInset()
  }

  // Android back should put the sheet away rather than leave the page, so
  // opening it pushes a history entry to spend.
  if (!popstateHandler) {
    popstateHandler = () => {
      if (!ui) return
      sheetHistoryPushed = false
      if (ui.compose.panelOpen) setPanelOpen(false, { fromHistory: true })
    }
    window.addEventListener('popstate', popstateHandler)
  }
}

function setPanelOpen(open, options = {}) {
  if (!ui) return
  ui.compose.panelOpen = open
  const el = document.getElementById("tbCompose")
  if (!el) return
  el.classList.toggle("panel-open", open)
  if (isPhoneLayout()) {
    if (open && !sheetHistoryPushed) {
      try { history.pushState({ tbSheet: true }, '') ; sheetHistoryPushed = true } catch { /* no history access */ }
    } else if (!open && sheetHistoryPushed && !options.fromHistory) {
      sheetHistoryPushed = false
      try { history.back() } catch { /* nothing to go back to */ }
    }
    resyncKeyboardSoon()
  }
  el.querySelectorAll(".tb-sel, #tbPlus").forEach(b => b.setAttribute("aria-expanded", String(open)))
  if (!open) el.querySelectorAll(".tb-chiprow").forEach(row => row.classList.remove("flash"))
}

// A short pale-blue wash over the row that answers the button just pressed.
function flashRow(rowName) {
  const row = document.querySelector(`.tb-chiprow[data-row="${rowName}"]`)
  if (!row) return
  row.classList.remove("flash")
  void row.offsetWidth // restart the animation even on a repeat press
  row.classList.add("flash")
}

// Enter or Assign with something missing: open up, point at the row that
// fixes it, and say so in the summary line.
function flashMissing() {
  if (!ui) return
  const { personId, text } = ui.compose
  if (!text.trim()) { setPanelOpen(true); document.getElementById("tbInput")?.focus(); return }
  setPanelOpen(true)
  if (!personId) { flashRow("person"); ui.compose.missing = "person" }
  else if (!effectiveTypeId()) { flashRow("type"); ui.compose.missing = "type" }
  syncCompose()
}
function canSubmit() {
  const { personId, text, sending } = ui.compose
  // Text and a person are the spec's bar. A type is only required when
  // there is no default to fall back on — see defaultTypeId().
  return Boolean(personId && text.trim() && effectiveTypeId() && !sending)
}

function summaryHtml() {
  const { personId, missing } = ui.compose
  if (missing === "person" && !personId) return '<strong class="tb-summary-warn">Pick a person</strong>'
  if (missing === "type" && !effectiveTypeId()) return '<strong class="tb-summary-warn">Pick a type</strong>'
  if (!personId) return "Pick who this goes to."
  const person = ui.rosterById[personId]
  const typeId = effectiveTypeId()
  const type = typeId ? TYPE_BY_ID[typeId] : null
  const due = dueShortLabel(ui.compose.due).toLowerCase()
  const where = type ? ` in <strong>${esc(type.label)}</strong>` : ""
  return `Goes to <strong>${esc(firstName(person))}</strong>${where}, due <strong>${esc(due)}</strong>`
}

function syncCompose() {
  const el = document.getElementById("tbCompose")
  if (!el || !ui) return

  // Midnight passed with the page still open: restamp the date chips, and pull
  // a selection that is now in the past forward to today, so the highlighted
  // "Today" chip and the date actually filed can't disagree.
  const today = todayISO()
  if (ui.composeDay !== today) {
    ui.composeDay = today
    if (daysUntil(ui.compose.due) < 0) ui.compose.due = today
    document.getElementById("tbDueRows").innerHTML = dueRowsHtml()
    wireDueRows()
    wireRadioKeys(el)
  }

  const { personId, typeId, due, stripOpen } = ui.compose

  const mark = (chip, on) => {
    chip.classList.toggle("active", on)
    chip.setAttribute("aria-checked", String(on))
  }
  el.querySelectorAll(".tb-chip-person").forEach(chip => mark(chip, chip.dataset.person === personId))
  el.querySelectorAll(".tb-chip-type").forEach(chip => mark(chip, chip.dataset.type === typeId))
  el.querySelectorAll(".tb-chip-due, .tb-day").forEach(chip => mark(chip, chip.dataset.due === due))

  // Roving tabindex: the chosen chip is the row's tab stop, or the first.
  el.querySelectorAll('[role="radiogroup"]').forEach(group => {
    const chips = [...group.querySelectorAll('[role="radio"]')]
    const chosen = chips.find(c => c.classList.contains("active")) || chips[0]
    chips.forEach(c => { c.tabIndex = c === chosen ? 0 : -1 })
  })

  const strip = document.getElementById("tbStrip")
  const toggle = document.getElementById("tbStripToggle")
  strip.hidden = !stripOpen
  toggle.classList.toggle("active", stripOpen)
  toggle.setAttribute("aria-expanded", String(stripOpen))

  // Selector buttons mirror the panel: unset ones stay grey and generic,
  // set ones carry the choice itself so the bar reads back what it will do.
  const person = personId ? ui.rosterById[personId] : null
  const selPerson = document.getElementById("tbSelPerson")
  selPerson.classList.toggle("set", !!person)
  selPerson.querySelector(".tb-sel-label").textContent = person ? firstName(person) : "Assign to"
  selPerson.querySelector(".tb-sel-icon").innerHTML = person ? avatarHtml(person, 18) : icon("user", 15)

  const type = typeId ? TYPE_BY_ID[typeId] : null
  const selType = document.getElementById("tbSelType")
  selType.classList.toggle("set", !!type)
  selType.querySelector(".tb-sel-label").textContent = type ? type.label : "Type"
  selType.querySelector(".tb-sel-icon").innerHTML = icon(type ? type.icon : "layers", 15)

  const selDue = document.getElementById("tbSelDue")
  selDue.classList.add("set")
  selDue.querySelector(".tb-sel-label").textContent = dueShortLabel(due)

  document.getElementById("tbSummary").innerHTML = summaryHtml()
  // The phone sheet has no room for the sentence, so the same three facts
  // go above the input as pills instead.
  const pills = [
    person ? firstName(person) : null,
    type ? type.label : null,
    dueShortLabel(due),
  ].filter(Boolean)
  document.getElementById('tbSummaryPills').innerHTML =
    pills.map(text => `<span class="tb-pill">${esc(text)}</span>`).join('')
  document.getElementById("tbAssign").disabled = !canSubmit()
}

async function submitTask() {
  if (!ui || !canSubmit()) return
  const { personId, due, text } = ui.compose
  const typeId = effectiveTypeId()
  const token = mountToken

  ui.compose.sending = true
  syncCompose()

  const { data, error } = await supabase
    .from('team_tasks')
    .insert({
      task_type: typeId,
      body: text.trim(),
      created_by: ui.me,
      assigned_to: personId,
      due_date: due,
      status: 'open',
    })
    .select('id')
    .single()

  if (token !== mountToken) return
  ui.compose.sending = false

  if (error) {
    syncCompose()
    toast(`Could not file it: ${error.message}`)
    return
  }

  const logged = await recordHistory(data.id, 'filed', personId)
  if (token !== mountToken) return

  // Everything resets, including the date: a fresh line should not inherit
  // the last one's deadline by accident.
  ui.compose.text = ''
  ui.compose.personId = null
  ui.compose.typeId = null
  ui.compose.due = todayISO()
  ui.compose.personTouched = false
  ui.compose.typeTouched = false
  ui.compose.missing = null
  ui.compose.stripOpen = false
  setPanelOpen(false)
  const input = document.getElementById('tbInput')
  if (input) {
    input.value = ''
    input.focus()
  }
  syncCompose()

  const filed = `Assigned to ${firstName(ui.rosterById[personId])} · ${TYPE_BY_ID[typeId].label}`
  toast(logged ? filed : `${filed} — but the history entry failed to save`)
  await refresh(token)
}

// ---------------------------------------------------------------------------

// options: { actionLabel, onAction, duration }. Announced politely rather
// than assertively — it reports what just happened, it does not interrupt.
function toast(message, options = {}) {
  document.querySelectorAll('.tb-toast').forEach(el => el.remove())
  const el = document.createElement('div')
  el.className = 'tb-toast'
  el.setAttribute('role', 'status')
  el.setAttribute('aria-live', 'polite')
  const label = document.createElement('span')
  label.textContent = message
  el.appendChild(label)
  if (options.actionLabel) {
    const action = document.createElement('button')
    action.type = 'button'
    action.className = 'tb-toast-action'
    action.textContent = options.actionLabel
    action.addEventListener('click', () => {
      el.remove()
      clearTimeout(toastTimer)
      options.onAction?.()
    })
    el.appendChild(action)
  }
  document.body.appendChild(el)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.remove(), options.duration || 2600)
}
