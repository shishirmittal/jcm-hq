# JCM-Tools (jcm-crm) — Complete Feature Inventory

Repo: `/home/claude/jcm-crm`. I read every file in `src/` and `api/` in full, plus `src/style.css` (2432 lines), `README.md`, `CLAUDE_CODE_HANDOVER (1).md`, `index.html`, `capacitor.config.json` and `package.json`. Line references are `file:line`.

**Two Supabase projects:**
- **CRM** = `cmtnzmfuasniicsdxyle`, reached through `src/supabase.js`.
- **BUSY** = `jlkjjqnmhsgefpluemyz`, reached through `src/supabase-busy.js` (a supabase-js client) and `src/busy-config.js` (raw REST `busyFetch`, used only by Control Centre).

---

## 0. Shell, routing and nav (applies to every page)

### Nav structure (`src/nav-config.js`)

| Section | Page id | Label | Icon | Hash | Badge | Flags |
|---|---|---|---|---|---|---|
| Main | `dashboard` | Dashboard | grid | `''` | — | — |
| Main | `tasks` | Task Board | clipboard | `#tasks` | openTasks | — |
| CRM | `leads` | Project Leads | briefcase | `#leads` | openLeads | — |
| CRM | `architects` | Architects | building | `#architects` | — | — |
| CRM | `electricians` | Electricians | bolt | `#electricians` | — | — |
| Sales | `quotations` | Quotations | file | `#quotations` | pendingQuotes | — |
| Sales | `orders` | Order Planning | box | `#order-planning` | — | — |
| Sales | `payments` | Payments | card | `#payments` | — | adminOnly |
| Management | `control` | Control Centre | chart | `#dashboard` (hash name collision is deliberate) | — | adminOnly |
| Management | `users` | Manage Users | users | `#admin` | — | adminOnly, grantable:false |
| Management | `price-update` | Price Update | pencil | `#price-update` | — | adminOnly, grantable:false |
| Management | `items-management` | Items Management | layers | `#items-management` | — | adminOnly |

Two routes are not in the nav:
- `#profile` is ungated.
- `#stock` is routed before any permission check (`main.js:162`). It is reachable on the web too, but appears only in the Android tab bar.

### Permissions (`src/permissions.js`)
- [ ] Admin = `profile.is_admin === true || profile.role === 'admin'` (`permissions.js:29`). Admins see everything.
- [ ] Non-admins see only the ids listed in `profiles.allowed_tabs`. A null or missing value means nothing is granted.
- [ ] `visibleNav()` removes unpermitted items **and** any section left empty, from the DOM itself (not hidden with CSS).
- [ ] `tabForHash`: exact match first, then a `hash/…` prefix match. Detail routes (`#architects/<id>`, `#order-planning/<tab>`, `#payments/feedback`) inherit their parent tab's access.
- [ ] An unknown hash is judged as Dashboard.
- [ ] `fallbackHash`: Dashboard if allowed, otherwise the user's first visible tab.
- [ ] Blocked route: a toast `.app-notice` "You don't have access to that page." shows for 3s, then the user is redirected. On native the redirect goes to `#tasks` when allowed. The notice is bottom-centre with `@keyframes appNoticeRise` (160ms, opacity plus translateY 8px) — `style.css:1360-1361`.
- [ ] A user with zero tabs gets the `renderNoAccess` screen: "No access has been set up for your account yet — ask an admin." plus a Sign out button (`main.js:115`).
- [ ] `adminOnly` is now only a warning shown in Manage Users. It does not gate anything.

### Session and app boot (`main.js`)
- [ ] `initTheme()` runs before render, so there is no flash of the wrong theme.
- [ ] Startup: `getSession` → `enterApp` or `renderLogin`.
- [ ] `onAuthStateChange`:
  - `SIGNED_IN` calls `enterApp` only if not already in a session. A same-session SIGNED_IN fired on tab refocus is ignored so unsaved forms are not wiped.
  - `SIGNED_OUT` tears down Control Centre, the Task Board realtime channel, the Stock timers, the pinned sidebar and the native shell, then shows the login screen with any pending message.
- [ ] `enterApp`:
  1. `profiles.active === false` → sign out with the message "Your account has been deactivated. Contact your administrator."
  2. `setPermissions`.
  3. No name yet → `renderProfileSetup`.
  4. No tabs → no-access screen.
  5. Native → `mountNativeShell`, default hash `#tasks`. Web → `mountPinnedSidebar`.
- [ ] `route()` unmounts the Control Centre React root, the Task Board (realtime channel) and Stock (timers) whenever the user leaves those routes.
- [ ] Control Centre's `control-centre.js` (React + Recharts) is loaded by dynamic `import()` and cached.
- [ ] Offline banner `#offlineBanner` (`.offline-banner`): "No internet connection — showing what was already loaded". It is fixed at the bottom above the tab bar, z-index 2000, and listens to `online`/`offline` (`main.js:226-240`, `style.css:2315`).

### Desktop pinned sidebar (`sidebar.js:132`, ≥800px only)
- [ ] Logo, "JCM Retails" and "CRM" subtitle.
- [ ] Section headers are uppercase, 10px, `--faint`.
- [ ] `.nav-row` is 40px tall. Hover gives `--line-soft` background, `--ink` text and a darker icon. Background and colour transition over 0.12s. Active row uses `--blue-bg` with blue text and weight 600. Focus-visible shows a 2px blue outline (`style.css:243-258`).
- [ ] Active row matching: exact hash or `hash/…` prefix; Dashboard matches only `''`. Updates on `hashchange`.
- [ ] Badges (`.nav-badge`, a blue pill) show `99+` above 99 and are hidden at 0. Counts:
  - openLeads = `projects.status='New Lead'`
  - pendingQuotes = `projects.status='Quotation Given'`
  - openTasks = `team_tasks` open and `assigned_to = me`
- [ ] `refreshNavBadges()` is exported. Task Board calls it after every change.
- [ ] **Collapse button**: a round 22px button at the edge (`top: 68px; right: -11px`).
  - Width animates 248 → 64px (`transition: width 0.18s`), and `#app`'s margin-left animates in step (0.18s).
  - Stored in localStorage `sidebarCollapsed`.
  - Collapsed state: labels hidden, section headers fade to opacity 0 at 12px tall, badges become a 7px dot at the top-right of the row, the account chip shows only its avatar, and the account menu opens to the right (`style.css:295-339`).
  - Chevron icon flips; hover turns it blue.
- [ ] **Theme toggle** (`.theme-toggle`): a 42×23 switch with sun and moon icons. The thumb slides `left 2→21px` over 0.18s; background and border transition over 0.15s. `role=switch`, `aria-checked`. Title is "Switch to light/dark mode" (`style.css:349-356`).
- [ ] **Account chip**: coloured avatar initial (`avatarColor` hashes the id across 7 colours), name and a chevron. Clicking toggles a menu with "Edit profile" (→ `#profile`) and "Sign out" (red; hover `--red-bg`). Any click on the document closes the menu.
- [ ] `.pinned-account-menu[hidden]{display:none}` is required: author `display:flex` overrides the browser's `[hidden]` rule. The same pattern recurs in several components.

### Mobile drawer (`sidebar.js:229`, `openSidebar`)
- [ ] Opened by every page's ☰ `.btn-hamburger`. Note: that button is **also visible on desktop** — only `.im-hamburger` is hidden at ≥800px.
- [ ] The overlay fades `rgba(0,0,0,0)`→`.5` over 0.25s. The panel is 260px wide (max 85vw) and slides from `translateX(-100%)` over 0.25s; it is added via requestAnimationFrame and removed after 250ms (`style.css:261-264`).
- [ ] Contents: logo, close button (chevron-left), the same nav markup and badges, a "Dark mode" row with the toggle, "Edit profile" and "Sign out". Clicking the backdrop closes it.

### Global button and CSS tokens (`style.css`)
- [ ] `.btn-primary:hover` uses `--blue-dk`. `.btn-ghost:hover` uses `--bg`. Disabled buttons have opacity .5 and `cursor: not-allowed`.
- [ ] The `body` background and colour transition over 0.15s on theme change.
- [ ] Inputs and selects get a blue border on focus with no outline.
- [ ] Project status badge colours live at `style.css:93-99`.

---

## Page: Login (`src/login.js`, `api/pin-login.js`)
- [ ] 4-digit PIN pad: digits 1–9, spacer, 0, backspace. On the web the backspace is `⌫`; in the app it is a backspace icon.
- [ ] Four dots fill as digits are entered (`.pin-dot.filled`; background and border transition 0.15s). Keys are 64px; `:active` background is `--line`.
- [ ] Auto-submits on the 4th digit. Keys are disabled while busy.
- [ ] POSTs `apiUrl('/api/pin-login')` with `{pin}`, then calls `supabase.auth.setSession({access_token, refresh_token})`. The SIGNED_IN listener takes over from there.
- [ ] Error messages:
  - "Could not reach the server, try again" (network)
  - On a 429, the server's message ("Too many attempts, try again later")
  - Otherwise "Incorrect PIN, try again"
  - The PIN resets after any error.
- [ ] Deactivated-account message is passed through `renderLogin(app, message)`.
- [ ] **Web layout**: centred card with a 72px round logo, "JCM-Tools" and "Electrical & Electronic Projects".
- [ ] **Native layout (`.app-login`)**:
  - Full-height navy brand area: 104px logo with a navy+gold ring, "JCM Tools" in Playfair 34px, a gold rule.
  - White bottom sheet with 28px top radius, heading "Enter your 4-digit PIN", hint "Your PIN keeps the app locked on this phone" (hidden while an error shows, via `:empty`), footer "J.C. Mittal & Sons · Ratlam".
  - Uses `100dvh` (`style.css:1953-2072`).
- [ ] **Server (`api/pin-login.js`)**:
  - CORS allowlist from `_cors.js`: `https://localhost`, `http://localhost`, `capacitor://localhost`.
  - Rate limit: 5 failures per IP per 15 minutes, checked in `pin_login_attempts` **before** the PIN lookup. Only failures are recorded.
  - Looks up `user_pins.pin` → `user_id`.
  - Mints a session with `auth.admin.generateLink(magiclink)` then `verifyOtp`.
  - Requires the env var `SUPABASE_SERVICE_ROLE_KEY`.

## Page: Profile setup / edit (`profile-setup.js`, `profile-edit.js`, `profile-form.js`)
- [ ] Setup is forced when `profiles.name` is empty ("Welcome!" / "Set up your profile"; no Cancel).
- [ ] Edit is reached at `#profile` ("Edit profile" / "Update your details"; has Cancel).
- [ ] Fields: Name * (autofocused), Mobile number, City. Enter in any field saves.
- [ ] Writes `profiles.update({name, phone, city})`.
- [ ] Validation: "Name is required". The button shows "Saving..." while saving. Errors appear inline.

---

## Page: Dashboard
**Id** `dashboard`, **hash** `''`, **source** `src/dashboard.js`. **Who**: admins, or anyone with `dashboard` in `allowed_tabs`.

Each section loads independently, shows its own pulsing skeleton (`@keyframes dash-pulse` 1.4s infinite, `style.css:450`), and on failure shows its own inline error with a Retry button (`.dash-error`).

**Header**
- [ ] Greeting: "Good morning/afternoon/evening, <first name>" (cut-offs at 12:00 and 17:00), followed by the long en-IN date.
- [ ] Buttons: "+ New Lead" opens the project form modal; "+ New Quotation" opens the quotation form in place. Both return to the Dashboard afterwards.

**Today's priorities** (three tiles in a grid separated by 1px gaps; hover `--line-soft`)
- [ ] "Follow-ups due": static 0, "Not tracked yet", tooltip, not clickable.
- [ ] "Quotations awaiting response": count of projects with status `Quotation Given`. "View quotations ›" goes to `#leads` filtered to that status.
- [ ] "New leads this week": count of `New Lead` projects with `created_at` in the last 7 days. Goes to `#leads` filtered to `New Lead`.
- [ ] Filters are passed via the sessionStorage key `leadsStatusFilter`, which Project Leads reads once and removes.

**KPI cards** (4 across; 2×2 below 640px)
- [ ] Hover: border `--faint` plus a box-shadow (0.12s). Static cards use `cursor: default`.

| Card | Value | Subtitle | Click |
|---|---|---|---|
| Today's Leads | projects created today | "+N since yesterday" in green when up, or "Same as yesterday" | `#leads`, unfiltered |
| Pending Quotations | count of `Quotation Given` | "N over 7 days old" | `#leads` filtered |
| Won This Month | `compactMoney` (₹x.xL / Cr / K) of `value` for Project Final + Partial Won created this month | "N projects closed" | static |
| Low Stock Alerts | BUSY `reorder_suggestions` count with `suggested_order_qty > 0` | — | `#order-planning`; shows "—" / "Order Planning unavailable" if BUSY errors |

**Sales pipeline**
- [ ] Six stage buttons for `PROJECT_STATUSES`, each with a count and a 3px coloured bar (`dashboard.js:12`).
- [ ] Vertical dividers between stages (`::after`). Hover `--line-soft`.
- [ ] Click goes to `#leads` filtered to that stage.

**Quick actions**
- [ ] New Lead (primary blue), New Quotation, Project Leads, Order Planning. Hover changes background and icon colour.

**Recent activity**
- [ ] Merges the latest 30 projects and latest 30 quotations, sorted by `created_at`.
- [ ] Rows show an icon (blue user for projects, amber file for quotations), title, detail and a relative time ("just now", "N min ago", "N hrs ago", "Yesterday", "N days ago", then a date).
- [ ] Pages 10 at a time with a "Load more" button.
- [ ] Empty: "No recent activity yet — new leads and quotations will show up here."

**Data**: CRM `projects` (counts, `value`, `status`, `client_name`, `location`, `created_at`), `quotations`; BUSY `reorder_suggestions`.

**Mobile (<640px)**: padding shrinks, header buttons go full width, priorities stack in one column, KPIs go 2-up, the two-column row stacks.

---

## Page: Task Board  ← the most interaction-dense page
**Id** `tasks`, **hash** `#tasks`, **source** `src/task-board.js` (1626 lines), **CSS** `style.css:1043-1621` (plus native rules at `:1669-1678`). **Who**: anyone with `tasks` granted. On native this is the home tab.

### Data and access
- [ ] Profile via `getCurrentProfile`. Admin check uses `isAdminProfile`.
- [ ] Roster: `profiles` with `id, name, email, role, hide_from_roster`, `active = true`, ordered by name.
  - `roster` excludes `hide_from_roster` and is used for pickers and @mentions.
  - `rosterById` includes everyone and is used for display.
- [ ] `task_card_access (user_id, task_type)`:
  - A card type with no rows is open to everyone.
  - A card type with rows is restricted to the listed users. Others neither see the stack nor get its chip.
  - Types marked `adminOnly` (Other) hide the composer chip from non-admins but keep the stack visible.
- [ ] Tasks: `team_tasks` select `*` where `status='open'`, ordered by `due_date` ascending, nulls last.
- [ ] History: `team_task_history` by `task_id`, ordered by `created_at` ascending.
- [ ] **Realtime**: channel `task-board`, `postgres_changes` `*` on `team_tasks` and `team_task_history`. Each event triggers a full reload, debounced 180ms, followed by `refreshNavBadges()`. The channel is removed on unmount.
- [ ] **Tone ticker**: every 60s it repaints only if a task's colour band has changed (e.g. at midnight), and never while an edit, due picker or pass picker is open.
- [ ] A `mountToken` guards against stale async results.
- [ ] **localStorage `taskBoardCollapsedStacks`**: a JSON array of folded card ids; unknown ids are dropped on load.

### Card types (`CARD_TYPES`, `task-board.js:16`)

| id | Label | Short | Icon |
|---|---|---|---|
| payment | Payments | Payment | card |
| order | Material Orders | Order | box |
| client | Client Requests | Client | users |
| service | Service Urgencies | Service | bolt |
| delivery | Pending Deliveries | Delivery | truck |
| payment_followup | Payment Follow Up | Follow up | chase |
| other | Other Tasks (adminOnly filing) | Other | ellipsis |

Each type has a keyword list used for auto-detection.

### Header (`.tb-head`)
- [ ] Title "Task Board". Subtitle "N open in this view · M overdue".
- [ ] **Scope segmented control**: "Everything I'm in" (default), "Assigned to me", "Assigned by me", and "All tasks" (admins only).
  - Active segment: surface background with a shadow. Hover changes text to ink.
  - Below 860px it becomes a 2-column grid; an odd last item spans both columns.
- [ ] **Per-person chips**: a 26px avatar plus the open count for each roster member, ignoring the scope. Idle people (0 open) render at opacity .5. Tooltip "Name · N open".

### KPI chips (4 across; 2 across below 860px)
- [ ] Overdue (alert-triangle, red), Due today (clock, red), Next 3 days (calendar, amber), Later (layers, green).
- [ ] Counted within the current scope. The icon tile uses the tone's pill colours.

### Stacks grid
- [ ] Columns: 3 by default, 2 below 1180px, 1 below 860px.
- [ ] Each stack header shows a 24px icon tile, label, count pill, and a chevron (chevron shown only below 860px).
- [ ] **Fold/unfold (≤860px only)**: the header gets `cursor:pointer`, min-height 44px and a hover background. The chevron rotates -90° when collapsed (`transform 0.15s`). The body is hidden.
  - On desktop the click still toggles state, but CSS does not hide the body.
- [ ] Rows are sorted ascending by days until due, undated last.
- [ ] Empty stack: "Nothing pending here."
- [ ] Each stack is a `container-type: inline-size` container.

### Task row
- [ ] **Colour = due tone only** (no priority field):
  - red when ≤0 days (today or overdue)
  - amber for 1–3 days
  - green beyond 3 days, or no date
- [ ] The whole row is filled with the tone colour (`--tb-fill`). Tone variables are at `style.css:1072-1079`; dark mode uses translucent fills and `color-mix` for the float background.
- [ ] Entry animation: `@keyframes tbRise` (180ms ease-out, opacity 0 + translateY 6px). It runs on every row render.
- [ ] Task text: 15.5px bold, wraps freely (`overflow-wrap: anywhere`), full text in the title attribute.
- [ ] **Due pill** (`.tb-due`, a button):
  - Labels: "Overdue", "Overdue · Nd", "Today", "Tomorrow", a weekday name when under 7 days, otherwise "d Mon", or "No date".
  - Hover: inset 1px ring in ink colour. Focus-visible: blue outline. Background transitions over 200ms.
- [ ] **HOVER ACTIONS (pointer devices, `@media (hover:hover) and (pointer:fine)`)**:
  - A `.tb-task-float` panel is absolutely positioned just left of the due pill (`right:100%`, 10px gap). At rest it is opacity 0, translateX(6px) and ignores pointer events.
  - Contents: meta (16px from-avatar → arrow → to-avatar, a screen-reader-only "From X to Y.", and the age "Nm/h/d ago"), then three buttons: **History**, **Pass on**, **Done**.
  - **Hover-intent delay of 300ms** (`--tb-hover-intent`). After it, the float fades and slides in over 160ms ease-out, the row background switches to `--tb-fill-hover`, and the due pill takes `--tb-tag-hover`.
  - On mouse-out everything reverts with no delay: the float fades out over 150ms ease-in.
  - A 24px gradient on the float's left edge (`::before`) fades the task text into it.
  - The float background is opaque (`--tb-float-bg`).
  - `:focus-within` reveals the float immediately with no delay, for keyboard users (`style.css:1163-1222`).
- [ ] **Action buttons** `.tb-btn`:
  - 32px tall, borderless, white at 60% (12% in dark mode). Hover 90% white. Focus shows a blue outline on a surface background.
  - **Done** uses the solid `--tb-strong` tone colour with white text; hover applies `filter: brightness(1.08)`.
- [ ] **Touch devices (`hover:none`)**:
  - The float is hidden. Tapping the row (anywhere except a control) expands it.
  - Only one row is expanded at a time (`ui.expandedTask`).
  - The `.tb-task-expand` accordion animates `grid-template-rows: 0fr → 1fr` over 200ms ease-out.
  - Expanded content: meta plus a 3-column grid of 44px buttons (History / Pass on / Done).
  - The expanded row uses the hover fill. The tap highlight is removed (`style.css:1514-1527`).
- [ ] **Inline edit**:
  - **Double-click** the task text to edit, allowed only when you are the creator or assignee. On touch, `touch-action: manipulation` means a double-tap triggers it instead of zooming.
  - The text becomes an auto-growing textarea with matching font metrics, a 70% white background and a blue border.
  - **Enter** saves, **Escape** cancels, **blur** saves. Blur is suppressed while the board repaints.
  - Empty or unchanged text cancels.
  - Saving is optimistic (local repaint first), then `team_tasks.update({body})`, then a history row `edited`, then the toast "Task updated".
  - Realtime repaints keep the draft text and caret.
- [ ] **Due picker** (click the due pill):
  - An inline `.tb-panel` labelled "Due" with presets: Today, Tomorrow, In 3 days, "By <Mon>" (next Monday, or a week out when today is Monday), Next week. Each has a long-date tooltip. The current date is highlighted.
  - A "Pick a day" toggle opens an inline 15-day strip of `.tb-day` buttons. Each day has a 3px top border in the tone that date **would** produce.
  - Choosing a date: `team_tasks.update({due_date})`, optimistic repaint, history `due_changed`, toast "Due Wed, 15 Oct". Choosing the same date simply closes the picker.
  - Opening this picker closes the pass picker, and vice versa.
- [ ] **Pass on**:
  - An inline panel "Pass on to" listing roster pills (20px avatar plus name), excluding the current assignee. The creator appears as "Back to <first name>".
  - Hover: blue border and text.
  - Writes `team_tasks.update({assigned_to})`, then history `passed` or `sent_back` with `to_user`. Toasts: "Passed on to X" or "Sent back to X".
  - With nobody to pass to: "Nobody else to pass this to."
- [ ] **History**:
  - Toggles an inline panel that shows "Loading history…" first, then rows: avatar, "<b>Actor</b> verb <b>Target</b>", relative time.
  - Verbs: filed this for, passed it to, sent it back to, marked it done, changed the due date, edited the text.
  - Empty: "No history recorded for this task."
  - Open history panels are reloaded on every board reload.
- [ ] **Done**:
  - `update({status:'done', done_at})`, then history `done`. The row disappears on reload.
  - Toast "Marked done" with an **Undo** action, kept for 5s. Undo sets `status:'open', done_at:null`, deletes that history row, and toasts "Brought back".
- [ ] Any write failure shows a toast "Could not …: msg". If the history write fails, the success toast gets "— but the history entry failed to save" appended.
- [ ] Toast (`.tb-toast`): an ink-coloured pill centred at the bottom, 84px up (above the composer; on native also above the tab bar). Animation `tbToastRise` 160ms. Default duration 2600ms. `role=status`, `aria-live=polite`. A new toast replaces the old one.

### Composer / assign bar (rendered once and never re-rendered, so typing is preserved)
- [ ] **Desktop (>860px)**:
  - Sticky at the bottom of the main column: rounded top corners and an upward shadow.
  - Resting row: a `+` button (opens or closes the panel), a text input ("What needs doing? Type @name to pick a person."), selector buttons **Assign to**, **Type** and **Due** (each opens the panel and flashes the matching row), and an **Assign** button.
- [ ] Selector buttons show the chosen value: an avatar plus first name, the type icon plus label, or the short due label. Chosen selectors get the `.set` style (blue-bg, blue text). Due is always set.
- [ ] **Panel open/close animation**:
  - `.tb-assignpanel-wrap` animates `grid-template-rows 0fr→1fr` over 260ms `cubic-bezier(.2,.8,.2,1)`.
  - The inner panel goes opacity 0→1 and translateY(10px)→0 over 220ms. The border turns light blue (`#93c5fd`) with a blue-tinted shadow.
  - Chip rows rise in staggered (`tbRowIn` 200ms; delays 40/80/120ms).
  - Closing is quicker: 180ms ease-in, no stagger.
  - `prefers-reduced-motion` disables all of these (`style.css:1395-1498`).
- [ ] The panel is absolutely positioned above the bar, so opening it does not shift the board.
- [ ] Chip rows inside the panel:
  - "Assign to": person chips with a 20px avatar and first name; your own chip says "Me".
  - "Type": only the types you may file into; desktop shows full labels.
  - "Due": the 5 presets plus "Pick a day", which toggles the 15-day strip on desktop. On a phone it opens the hidden native `<input type=date>` via `showPicker()`, with a min date.
- [ ] Chips: 30px (34px in the panel). Hover border `--faint`. Active is blue. `:active` scales to .97. Background, border and transform transition over 120ms.
- [ ] **Flash**: a selector click or a missing-field prompt plays `tbRowFlash` on that row (600ms, blue-bg → transparent). Repeated presses restart it via a reflow.
- [ ] **Keyboard**:
  - Input: **Enter** submits, or if something is missing flashes the missing row and shows a warning. **Escape** closes the panel.
  - Chip groups use roving tabindex: **Arrow keys** move, **Home/End** jump, **Space/Enter** select.
  - The summary line hints "Enter to assign · Esc to close".
- [ ] **Auto-detection while typing**:
  - `@name` picks a person when it matches unambiguously; the last mention wins.
  - The type is guessed from keyword counts.
  - Either guess stops once the user has tapped a chip for that field.
- [ ] Summary line (shown only when the panel is open): "Goes to **X** in **Type**, due **today**", or the warnings "Pick a person" / "Pick a type" in amber.
- [ ] Default type: "other" for admins. Non-admins must pick a type.
- [ ] The Assign button is disabled until text, a person and a type are set. Disabled style: grey background.
- [ ] Clicking or touching outside the composer closes the panel but keeps the draft.
- [ ] Submit:
  - Inserts into `team_tasks` `{task_type, body, created_by, assigned_to, due_date, status:'open'}`, then history `filed` with `to_user`.
  - Resets everything (due back to today), refocuses the input, toasts "Assigned to X · Type".
- [ ] Past midnight, the due chips are re-stamped, and a due date now in the past moves to today.
- [ ] **Phone (≤860px) bottom sheet**:
  - The composer is `position: fixed`, with `bottom` set to the keyboard height. `--tb-keyboard` and `--tb-viewport` come from `visualViewport`, re-checked at 0, rAF, 120 and 400ms.
  - At rest it shows only a 44px rounded input and a 44px round send-icon button.
  - Open: a sheet with a 40×4 drag handle (tap or **swipe down >40px** to close), chip rows as horizontal swipe lists (scroll-snap, hidden scrollbars, 44px chips, short type labels), summary pills (person / type / due) above the input, and a 280ms animation.
  - The sheet's height is capped to the visible viewport. The board gets 96px of bottom padding.
  - **The Android back button closes the sheet**: opening it pushes a history state, and a `popstate` handler closes it.
- [ ] Error and empty states: "Could not load your profile.", "Could not load the team: …", "Could not load the board: …". Skeleton cards (`skeletonPulse` 1.1s, staggered 0.12s) show while loading.

---

## Page: Project Leads
**Id** `leads`, **hash** `#leads`, **sources** `src/project-leads.js`, `project-form.js`, `project-detail.js`, `photos.js`.

**List**
- [ ] Header: ☰, "Project Leads", and a "+ Add project" button (opens the project form modal).
- [ ] Stats: Total projects, Won (₹ sum of `value` for Project Final + Partial Won), Active (count of Quotation Given).
- [ ] Controls:
  - Live search on client name, city/location and description.
  - Status select (All statuses plus the 6 statuses) — a server-side `.eq`.
  - City select built from the distinct `city || location` values — filtered client-side.
- [ ] One-shot pre-filter from sessionStorage `leadsStatusFilter`.
- [ ] Cards (`.project-card`):
  - Hover: blue border (0.15s).
  - First photo shown as an 88px thumbnail.
  - Client name, then meta "City · Architect: <linked contact name, or legacy architect text>", status badge (coloured per status), and product-stage tags.
  - Contact buttons appear when there is a whatsapp/phone value: "📞 Call" (`tel:+91…`) and "💬 WhatsApp" (`wa.me`). These stop click propagation. Hover darkens the tint.
- [ ] Clicking a card opens the project detail view.
- [ ] Loading: "Loading projects...". Error: "Couldn't load projects: …". Empty: "No projects yet. Click "+ Add project" to get started."
- [ ] Query: `projects` select `*, project_photos(url,path,created_at), architect_contact:industry_contacts!architect_id(name)`, newest first.

**Project form modal** (add/edit, `project-form.js`)
- [ ] Bottom sheet on mobile, centred at ≥640px. Closes on backdrop click, ✕ or Cancel. Client Name is autofocused.
- [ ] Fields: Client Name *, WhatsApp Number, City (stored in `location`), Address.
- [ ] **Architect** and **Electrician** comboboxes:
  - Type to search `industry_contacts` by name and firm (up to 8 results).
  - The last row is always "+ Add "X" as new architect/electrician", which inserts the contact inline.
  - ↑/↓/Enter/Esc work; a blur closes after 150ms; selection is on mousedown.
  - Typing clears the selection; leaving the field empty unlinks the contact.
- [ ] Product Stage: checkbox chips (Conduit, Wiring, Lights, Switches, Fans, Decoratives, Appliances). A checked chip turns blue via `:has()`.
- [ ] Status select; Notes/Remarks textarea (stored in `description`).
- [ ] Photos:
  - "+ Add photos" (multiple, `image/*`).
  - For a new project, photos are staged locally as object URLs and uploaded after save.
  - When editing, they upload immediately with "Uploading i of n...".
  - Each thumbnail has a ✕ delete button (hover turns red).
- [ ] Save:
  - "Client name is required". Button shows "Saving...".
  - Insert or update `projects` with `{client_name, whatsapp, location, address, architect_id, electrician_id, product_stages, status, description, created_by}`.
  - Errors appear inline.

**Project detail** (`project-detail.js`; no hash — rendered in place)
- [ ] Header: "← Back", "Edit" and "Delete" (red).
- [ ] Delete: `confirm('Delete this project?')`, removes the storage photos and then the project row.
- [ ] Card 1:
  - Client name (22px), city, legacy architect text.
  - Referral links "Architect: <a #architects/id>" and "Electrician: <a #electricians/id>".
  - **Status as a coloured pill-shaped `<select>`**; changing it updates `projects.status` and re-renders.
  - Pill buttons "📞 Call <phone>" and "💬 WhatsApp".
- [ ] Card 2:
  - "Edit" button, 📍 address, stage pills with per-stage colours (`style.css:226-234`).
  - Progress bar of N of 7 stages (`#4f46e5`; width transition 0.2s), italic description.
  - Empty: "No additional details yet."
- [ ] Quotations card:
  - "+ New quotation" pre-fills the quotation form with client, phone, city, address and `project_id`.
  - Rows show quote_no (or "Draft"), the date, and "brand — model". Hover gives a blue border. Clicking opens the quotation view.
- [ ] Meetings card:
  - "+ Schedule" toggles an inline form: date (default today), time, notes.
  - "Meeting date and time are required."
  - "Save & Add to Google Calendar" inserts into `meetings` and then opens a Google Calendar render URL (1-hour event) in a new tab.
  - The list is sorted by date and time, descending.
- [ ] Notes card:
  - List of `content` plus a timestamp.
  - Input "Called, quoted, site visit done..." with an Add button; **Enter** also adds. Inserts into `notes` with `created_by`.
- [ ] Photos card:
  - "+ Add Photos" uploads.
  - 3-column grid. Clicking a thumbnail opens a lightbox (85% black overlay; click to close). ✕ deletes after `confirm('Delete this photo?')`.
- [ ] Not found: "Project not found."
- [ ] `photos.js`: storage bucket `project-photos`, path `<projectId>/<timestamp>-<safename>`, public URL saved to `project_photos {project_id, url, path, created_by}`.

## Page: Architects / Electricians
**Ids** `architects`, `electricians`; **hashes** `#architects[/id]`, `#electricians[/id]`; **source** `src/industry-contacts.js` (one parameterised file).
- [ ] List: header "Architects" or "Electricians" with "+ Add Architect/Electrician". Search across name, phone and firm.
- [ ] Cards show name, "firm · phone · city", and a badge "N projects referred". The count comes from `projects.architect_id` / `electrician_id`, counted client-side.
- [ ] Clicking a card goes to `#architects/<id>`.
- [ ] Empty: "No architects yet. Click "+ Add Architect" to get started." Loading: "Loading architects...".
- [ ] Detail page:
  - "← Back" returns to the list hash. Edit opens the modal.
  - Delete confirms "Delete X? Projects that reference them will keep their history but show no architect.", then deletes.
  - Name, firm and city; Call/WhatsApp pills.
  - "Projects referred" cards (thumbnail, status badge) open the project detail.
  - Not found: "Architect not found."
- [ ] Modal: Name * (autofocused), Firm, Phone, City. Validation "Name is required". Insert includes `contact_type` and `created_by`.
- [ ] Table: `industry_contacts (id, name, firm, phone, city, contact_type, created_by)`.

---

## Page: Quotations
**Id** `quotations`, **hash** `#quotations`, **sources** `src/quotations.js`, `quotation-form.js`, `quotation-view.js`, `share-pdf.js`, `catalog.js`. This is a native tab.

**List** (all filtering and paging is client-side; the data is loaded once with `fetchAllRows`)
- [ ] Header: "+ New quotation".
- [ ] Filter bar:
  - Search on client name and quote no.
  - From/To date inputs with the word "to" between them.
  - Customer, Brand and Sales person selects (options built from the data).
  - **Apply Filters** and **Clear Filters** buttons. Filters are not live; nothing changes until Apply.
- [ ] Table columns: Quotation No., Date, Customer (with the `label` as a sub-line), Mobile (with a round green **WhatsApp** button), Items (count), Amount (sum excluding on-request lines), Sales Person (`created_by` mapped to a profile name), Actions.
- [ ] Rows: hover `--line-soft` (0.12s); clicking opens the view.
- [ ] Action buttons (28px squares; hover blue-bg, blue border):
  - ✏️ Edit
  - ⧉ Duplicate
  - 🖨️ Print
  - ⬇ Download PDF
  - Each opens the view with an `autoAction`. The WhatsApp button uses `autoAction='whatsapp'`.
- [ ] WhatsApp button: tinted `rgba(37,211,102,.16)`, darker on hover, adjusted for dark mode.
- [ ] Pagination:
  - "Showing X to Y of Z entries".
  - ‹ and › plus numbered pages with ellipses (first, last, current ±1). The active page is blue.
  - Per page: 10 (default), 25 or 50.
- [ ] Stats panel (cards in 2 columns):
  - Total Quotations and Combined Total Value (headline style, blue 26px).
  - LK Value, Legrand Value, Schneider Value (`Schneider Electric`), Mixed Value (brand "Mixed" or containing " + "), This Month's Quotations.
  - Money shown compact (₹23.18 L) with the full figure in the title tooltip.
- [ ] Layout:
  - ≥1400px: side by side, stats panel 340px with a divider.
  - 760–1399px: stats above the table.
  - **≤760px: each table row becomes a card**, using `data-label` pseudo-headings. Quote no and date share the top line; the customer has its own line; actions span the full width (40px buttons) (`style.css:2167-2255`).
- [ ] Empty: "No quotations match these filters." Skeleton while loading.
- [ ] Data: `quotations`, `quotation_items (quotation_id, amount, on_request, quotations(brand))`, `profiles (id, name, email)`.

**Quotation form** (`quotation-form.js`; rendered in place)
- [ ] Loads "Loading catalog..." from: `catalog_items`, `model_discount_presets`, `generic_items`, `generic_item_map` (module caches in `catalog.js`), `projects` (clients), and `profiles` for the history line.
- [ ] Header: "← Back", "New quotation" or "Edit quotation".
- [ ] **Card 1 — Client** (grey):
  - Name search with a 🔍 icon. Token match against `projects.client_name`, up to 8 results, showing phone and city as a sub-line.
  - ↑/↓, Enter picks (fills Phone, City and Address and links `project_id`), Esc closes. With nothing highlighted, Enter moves to the next field.
  - Highlighted row: `--grn-bg`. Scrolling is handled inside the dropdown only.
  - Phone, City (2 columns; 1 column below 700px), Address.
- [ ] **Card 2 — Meta strip**:
  - Quotation number (or "New Quotation"), today's long date.
  - **Pricing mode toggle**: Tax Paid / Discount + Tax. Discount + Tax reveals a GST % input (default 18).
  - Optional quotation label.
- [ ] **Card 3 — Add item**:
  - Search over `generic_items.name` by token match. Each suggestion shows "Available in <models>".
  - ↑/↓, **Enter** selects and moves focus to Qty; in Qty, **Enter** adds the line. A hint shows `<kbd>` keys.
  - Green "+ Add" button.
- [ ] **Card 4 — Pricing and items**:
  - Toolbar (hidden when there are no items):
    - **Sort by** pills: Item name, Model, Colour, Discount %. Sorting is manual; generic-brand items are pinned last; the active pill is blue.
    - **🔒 Lock all**.
    - **🔓 Unlock all**, which confirms "Unlock N row(s)? Each one rejoins its bucket…".
  - Desktop table columns: Item (name, model sub-line, "Added automatically" note), Model `<select>` ("brand — model"), Colour `<select>`, Qty, List (editable MRP; highlighted when overridden from the catalog), Disc %, Amount, a lock toggle and a × remove button.
  - **Below 700px the table is replaced by item cards** with the same fields.
  - Locked rows get an amber background.
  - Colour-mismatch rows get an amber outline plus the note "Not in this model: X · using Y".
  - Unmapped item: "No brand/model mapped yet".
  - **Bucket sync**: changing Model, Colour or Discount on one row updates every unlocked row in the same `generic_items.bucket`. A Model change in plates also updates accessories and vice versa. Locking a row detaches it; unlocking snaps it back to the bucket's values. `default_locked` / `default_discount` items start locked.
  - **Paired grid frame auto-add**: when the selected variant has `paired_frame_item_key`, the matching frame row is added automatically at the same qty.
  - Qty, MRP and Discount inputs patch the DOM live without losing focus. Enter in a row input moves to the next field.
  - Totals:
    - Tax Paid mode: Total Qty, Total List Price, Total Discount, and a "Tax Paid Total" bar (navy and gold, not themed).
    - Discount + Tax mode: adds Taxable Value, GST Amount (x%) and "Grand Total".
    - Extra lines: "+ N item(s) priced on request" and "N item(s) still need a model/colour".
  - History line when editing: "Created by X · date · Last edited by Y · date".
  - Buttons: Cancel, and "Save & Generate" or "Save changes".
- [ ] Save:
  - Validation: "Client name is required", "Add at least one item", "Every item needs a model and colour before saving".
  - Project linking: the picked client, otherwise a match on the last 10 phone digits, otherwise a new `projects` row. The project is set to `status 'Quotation Given'` with `value` and `product_category`.
  - Brand and model are derived: one brand → that brand plus its models; two → "A + B"; three or more → "Mixed".
  - Writes `quotations` (insert or update) with client_name, phone, address, city, brand, model, label, project_id, pricing_mode, gst_rate.
  - On edit, existing `quotation_items` are deleted first. New items are inserted with description, category, sub_category, model, colour, cat_no, qty, mrp, discount_pct, rate, amount, on_request and `sort_order` (the on-screen order).
  - Then opens the quotation view. `quote_no` is not set by the client; the database assigns it.

**Quotation view** (`quotation-view.js`)
- [ ] Header: "← Back", quote number, and actions:
  - Edit
  - "Duplicate as new quotation" (short label "Duplicate")
  - Print (`window.print`)
  - "Download PDF" (short label "PDF")
  - "Send via WhatsApp" (solid WhatsApp green; short label "WhatsApp")
- [ ] A4 letterhead pages (`.print-page`, 210mm), 18 items per page, "Page i of n":
  - Navy top bar with logo, "A Unit of J.C. Mittal and Sons", "Quotation / Not a Tax Invoice", and a **UPI QR encoding this quotation's grand total** (qrcodejs CDN; falls back to a static QR).
  - Contact bar; meta (Quotation No., Date "d · Mon · yyyy", Valid Until +7 days); "Quotation For".
  - Items table: #, Item, Model, Colour, Qty, List Price, Disc, Amount.
  - The last page adds totals (mode-aware), amount in words (Indian numbering), the bank strip (SBI details plus UPI), a brands list, 3 policy columns, and the signature footer.
  - Fonts: Cormorant Garamond and Inter.
- [ ] Print CSS: A4 with no margin, everything except the sheet hidden, exact colour printing forced (`style.css:914-935`).
- [ ] PDF: each page captured with html2canvas (scale 2), placed into jsPDF as JPEG at 0.92 quality. The button shows "Generating…" while working; a failure alerts "Could not produce the PDF: …".
- [ ] WhatsApp:
  - Web: synchronously opens `wa.me/<phone>?text=…` (message includes total and validity), then downloads the PDF and alerts "PDF downloaded — attach it in the WhatsApp chat…".
  - No phone: alerts "No phone number on this quotation".
  - Native: generates the PDF and opens the system share sheet with the file and message.
- [ ] Duplicate: opens the form with client details and items (description and qty only). Edit pre-fills the exact saved values.
- [ ] Native: the sheet is scaled to fit the screen width (`--sheet-scale`, recalculated on resize). The class `.qv-capturing` turns scaling off during capture. The header wraps onto two rows.
- [ ] `share-pdf.js`:
  - Web: `doc.save()`.
  - Native: `@capacitor/filesystem` writes to the Cache directory, then `@capacitor/share` shares the file. A user cancelling the share is ignored.
  - Filenames: `/:*?"<>|` replaced with `-`.

---

## Page: Order Planning
**Id** `orders`, **hash** `#order-planning[/dashboard|settings|declutter]`, **source** `src/order-planning.js`. All data comes from BUSY.
- [ ] Header pill (`loadSyncStatus`):
  - "Last synced: <date time>" from the latest `sync_log` row with `job='nightly'` (falls back to unfiltered if that query errors).
  - Warning style (amber, ⚠️) when older than 36 hours or `status='error'`; "(failed)" suffix and an `error_message` tooltip on error.
- [ ] Tabs (`.op-tab`, hover `--bg`, active blue underline): Reorder Dashboard, Item Settings, Declutter. Each tab is its own hash.

**Reorder Dashboard**
- [ ] Loads `reorder_suggestions` plus `items(code, avg_rate)`.
- [ ] Coverage line: "X items in reorder view · Y excluded (no sale rate) · Z stock unknown, verify manually" from `items.stock_source`.
- [ ] Category drill-down built from `category_path` split on " > ":
  - Breadcrumb "All › …" (clickable; hover blue-bg).
  - Card grid (`.op-brand-card`; hover blue border) showing "N items flagged" (counts `suggested_order_qty > 0` including descendants).
  - An extra "Other <node> items" card when a node holds items directly.
  - A leaf opens the item table. Empty: "No categories here."
- [ ] Search "Search categories or items...": matches category names or item name/alias under the current node. Cards show "N matches"; "Matching items here"; "Show all N matching items →" opens a flat list. Empty: "No matches for "x" here."
- [ ] Item table:
  - "← Back". "Plan for next [1] [day(s)/week(s)/month(s)]" recalculates live.
  - Suggested qty = ceil(max(0, avg_weekly × days/7 − stock) / min_order_qty) × min_order_qty. Null stock shows "Verify stock".
  - Grouped by brand with a header "N items · Est. order value ₹" (uses purchase_rate, falling back to avg_rate).
  - Sortable headers (▲/▼; active blue; hover muted): Item, Stock, Avg weekly, Suggested qty (default descending), Est. order value. Null values always sort last.
  - Badges: "⚠️ Verify stock" (needs_manual_check, tooltip) and "📋 Stock as of <date> (manual import)" (`busy_report_*`).
  - Rows with suggested qty ≤ 0 are hidden.
  - Empty: "Nothing needs reordering here for that period."
  - **Shortlist checkboxes** per row, plus "Select all N visible items".
- [ ] **Shortlist ("cart")**:
  - Module-level Map that survives navigation within the session.
  - A fixed bottom-right navy pill: "N items shortlisted" with a "View list" button.
  - Modal: Item, Brand, Stock, editable Qty, ✕ remove; "Clear all", "📋 Copy to clipboard" (shows "Copied ✓" for 1.5s), "⬇ Download CSV" (`reorder-shortlist.csv`).
  - Empty: "Nothing shortlisted yet."

**Item Settings**
- [ ] Search box ("Search items by name or alias…"), debounced 300ms. Queries `items.or(name.ilike, alias.ilike)` with no limit, then `reorder_settings.in(item_code)`.
- [ ] Table: Item, Min order qty (number), Preferred vendor (text), Save button.
  - Sortable on Item, Min qty and Vendor.
  - Paged 50 at a time: "Showing a–b of N matching items", "← Prev" / "Next →".
- [ ] Save upserts `reorder_settings {item_code, min_order_qty, preferred_vendor}` (on conflict `item_code`). Button cycles "Saving..." → "Saved ✓" or "Failed" → "Save" after 1.5s.
- [ ] `target_weeks_cover` is intentionally not editable.
- [ ] States: "Searching...", "Search failed: …", "No items match."

**Declutter**
- [ ] Source: `declutter_candidates` view.
- [ ] Explanatory note that the app never deletes anything.
- [ ] Filters (state persists for the session):
  - Search
  - Brand
  - Stock source: All / Synced / Manual import / Needs check / No sale rate
  - Seasonal: All / Seasonal / Non-seasonal (`is_seasonal`)
  - Sort select: Stock value high→low (default) / low→high / Weeks tracked / Name A→Z
- [ ] Sortable headers: Item, Stock, Sale rate, Purchase rate. Columns: Item (+ badge), Alias, Brand, Stock, Sale rate, Purchase rate.
- [ ] Paged 50 at a time with Prev/Next.
- [ ] "📋 Copy to clipboard" and "⬇ Download CSV" (`declutter-candidates.csv`) export the **full filtered set**, with a Stock Note column.
- [ ] Empty: "No declutter candidates right now." / "No items match these filters."

## Page: Payments
**Id** `payments`, **hash** `#payments[/feedback]`, **source** `src/payments.js`. adminOnly but grantable; also has an internal `canSee('payments')` guard ("You do not have access…" then redirect after 1.5s).
- [ ] Header: "Refresh" button.
- [ ] Stats: Total received (headline), Payments count, Avg. rating (or "—"), Needs follow-up (ratings ≤ 3).
- [ ] Tabs: "Payments received" and "Feedback" (separate hashes).
- [ ] Payments table: Name, Mobile ("+91 …"), Amount, Payment ID (`razorpay_payment_id`), Date ("dd Mon yyyy · hh:mm").
- [ ] Feedback table: Name, Mobile, Rating (★★★☆☆), Comments, Date.
- [ ] Each table loads the latest 200 rows.
- [ ] Data: CRM `pay_payments`, `pay_feedback` (written by pay.jcmretails.com).
- [ ] Empty: "No payments yet." / "No feedback yet." Errors show the error message.

## Page: Control Centre
**Id** `control`, **hash** `#dashboard`, **sources** `src/control-centre.js`, `control-centre-app.jsx` (React + Recharts; inline styles only — none in `style.css`). Guarded by `canSee('control')`.
- [ ] Its own always-dark palette (`C` object): background `#0f1117`, cards `#171a23`, indigo accent. It ignores the app theme.
- [ ] Sticky top bar: ☰ (opens the drawer), "JCM Retails · CONTROL CENTRE", Refresh button.
- [ ] Tab strip: Overview, Revenue, Receivables, Customers, Products, Inventory. Active tab is indigo with a 2px underline.
- [ ] Data via BUSY REST views: `v_monthly_revenue`, `v_daily_revenue`, `v_top_customers` (limit 25), `v_sales_by_group`, `v_top_items` (limit 25), `v_dues_summary`, `v_dues_by_route`, `v_stock_by_group`.
- [ ] **Overview**:
  - Stats (with a left accent border): Revenue this FY (April start), latest month with ▲/▼ % month-on-month, Receivables (parties), Payables, Stock value (SKUs), Avg invoice.
  - Revenue trend area chart (gradient fill) with range buttons 6m / 12m / 24m / All.
  - Receivables split donut (Retail amber, Distribution cyan) with mini-stats.
  - Top customers and Sales by product group as ranked lists with proportional coloured bars.
- [ ] **Revenue**: 4 stats; monthly bar chart (latest month amber); daily area chart for the last 90 days.
- [ ] **Receivables**: 4 stats; horizontal bars for the top 20 routes/groups coloured by segment, with a legend; table Group / Segment pill / Parties / Outstanding.
- [ ] **Customers**: top 25 horizontal bar chart; table #, Customer, Revenue, Invoices, Avg bill.
- [ ] **Products**: revenue by group (22 bars, colour palette); top 25 items table.
- [ ] **Inventory**: 3 stats; pie of the top 9 groups; breakdown rank list; table of all groups.
- [ ] Tables: sticky headers, max height 460px with scrolling. Custom tooltip shows ₹ and the invoice count.
- [ ] States: "Loading / Fetching from Busy ERP…" and "Could not load / <err>". Footer note about the ~0.6% reconciliation difference.
- [ ] Money format: ₹x.xxCr / L / K.

## Page: Manage Users
**Id** `users`, **hash** `#admin`, **sources** `src/admin.js`, `api/admin-users.js`. The client gate is `role === 'admin'`; the server gate is `profiles.is_admin`. This tab cannot be granted to non-admins.
- [ ] Header: "← Back", "Manage users", "+ Add User".
- [ ] User cards:
  - Name (or "Not set"), "(you)" marker, purple "ADMIN" badge.
  - Email, and **PIN shown in plain text**.
  - Active/Deactivated toggle (green or red; disabled for your own account). It writes `profiles.active` directly.
  - Edit button.
- [ ] Notes after saving: "Tab access saved. Changes apply next time X reloads the app." and "Email updated — …".
- [ ] Add/Edit modal (560px; **no close on backdrop click**):
  - Name *, Email *, PIN (4 digits; non-digits stripped as typed).
  - Checkbox "Hide from chat and task assignment" with a hint.
  - **Tab access grid**, built from `NAV_CONFIG` sections and icons:
    - "Select all" / "Clear all" (skip disabled boxes).
    - Rows are 36px labels: hover surface; checked rows get blue-bg and a blue icon; focus ring on the row.
    - ⚠ warning on `adminOnly` tabs. 🔒 dimmed and disabled on `grantable:false` tabs.
    - For an admin target, the grid is replaced by the note "Admins have access to all tabs".
  - Validation: "Name is required", "Enter a valid email address", "PIN must be exactly 4 digits".
- [ ] API (`POST /api/admin-users`, Bearer token):
  - `list`: profiles left-joined with `user_pins`.
  - `create`: checks the PIN is unique; `auth.admin.createUser` with a random password and `email_confirm`; upserts the profile (`is_admin:false, role:'staff'`, active, allowed_tabs, hide_from_roster); inserts `user_pins`; rolls back on failure.
  - `update`: changes the auth email when needed; updates the profile (never writes `allowed_tabs` for admins); updates or inserts the PIN with a uniqueness check.
  - `sanitizeTabs` keeps only ids that exist in NAV_CONFIG.
  - Errors: 401 / 403 "Admin access required" / "PIN already in use", and others.

## Page: Price Update
**Id** `price-update`, **hash** `#price-update`, **source** `src/price-update.js`. Requires `isAdminProfile`; cannot be granted. Writes are gated by the RLS policy "Admins can update catalog".
- [ ] Header: "← Back", "Price Update".
- [ ] Card "Columns to update": checkbox chips List Price (`mrp`, ticked by default), Cat No, Std Pack, Colour, Price on request (bool).
  - At least one must stay ticked ("Keep at least one column ticked.").
  - Unticking a column discards edits made in it.
- [ ] Card "Item group":
  - Brand (required), Model (optional), Category (optional) cascading selects built from the cached catalog.
  - "Go" is disabled until a brand is chosen.
- [ ] Card "Items":
  - Table: Item, Model, Category, Colour (read-only unless Colour is being edited), then the editable columns.
  - Header row is sticky. The table scrolls horizontally inside its own box.
  - Changed cells get an amber fill (`.pu-changed`).
  - A blank input means "no change".
- [ ] Footer:
  - "N rows changed · M with an invalid price" (negative or non-numeric price).
  - Reset; Save (disabled when nothing changed or anything is invalid).
- [ ] Save:
  - `confirm("Update N rows?\n\nColumns changing: …\n\nExisting quotations keep the prices they were made with.")`.
  - Writes per row, 8 at a time, `.update().eq('id').select('id')`, counting the rows actually written.
  - If not all rows were written: "Some rows were not saved. Check you are logged in as an admin."
  - On success calls `clearCatalogCache()`, reloads, and shows "N rows updated." in green.
- [ ] Fetch pages 1000 at a time, ordered by `id`.
- [ ] State resets on every visit.
- [ ] Mobile (<640px): pickers and footer stack vertically.

## Page: Items Management
**Id** `items-management`, **hash** `#items-management`, **source** `src/items-management.js`, **CSS** `style.css:937-1028` — deliberately unthemed, Busy-style. Guarded by `canSee`.
- [ ] Full-height layout with its own navy top bar. Its ☰ (`.im-hamburger`) is hidden at ≥800px.
- [ ] Top bar actions:
  - Yellow badge "N items changed" (hidden at 0).
  - "Undo Last Change", "Discard Changes" (hover red), "Export for Busy" (blue), "Ask AI".
- [ ] Left tree (320px):
  - Built from `item_groups` (code, parent_grp, name, full_path, depth, top_level) ordered by full_path.
  - `+` / `−` toggles expand each node. Rows are indented 18px per depth level.
  - Hover `#e4e9ef`; active `#cfe0f5` bold.
  - Blue badge with the number of pending edits beneath that group (rolled up to ancestors, shows 99+).
  - Error: "Failed to load groups: …".
- [ ] Items panel:
  - Header "<full_path> — N items" (includes subgroups; `item_group_map.group_path LIKE path%`). Prices come from `items(code, sale_rate, fixed_value)` in batches of 300.
  - Table (fixed layout, sticky header): Name, Alias, Group, Sale Price, Optional Field 2 (`fixed_value`, read-only), Remark 1–3.
  - **Sortable on Name and Sale Price** (↑/↓).
  - **Drag-resizable columns**: a 6px handle on each header edge, highlighted blue on hover; `body.im-col-resizing` sets the cursor; minimum width 40px. Widths persist across sorts and group switches.
  - **Group picker per row**: a searchable input over all 261 groups by `full_path` (up to 50 suggestions). ↑/↓/Enter/Esc; unpicked text snaps back on blur; full path in the title tooltip.
  - **Enter moves along the row**: Group → Price → Remark 1 → 2 → 3, then blur.
  - Changed rows are highlighted `#fff3cd`.
  - States: "Select a group on the left…", "No group selected.", "No items in this group.", "Loading items in …", "Failed to load prices…".
- [ ] Editing (on `change`):
  - Each edit is pushed onto an undo stack and immediately **upserted** into BUSY `item_pending_edits` (item_code, new_group_code, new_price, remark1–3, edited_at, exported:false).
  - Pending edits are resumed on load (`exported=false`).
- [ ] Undo reverts one field at a time.
- [ ] Discard: `confirm("Discard all N pending changes?")`, then nulls the fields (rows are never deleted).
- [ ] Export:
  - Builds an `.xlsx` with SheetJS: sheet "Items", headers Item Name, Item Alias, Item Group, Sales Price, Remark 1–3; file `items-bulk-update-YYYY-MM-DD.xlsx`.
  - Then marks the rows `exported:true` and clears local state.
  - Nothing pending: "Nothing to export."
- [ ] **Ask AI side panel** (340px, toggled):
  - Header "Ask about your data" with a × close.
  - Hint text; input "e.g. Top 5 items by sales last month" with Send. Form submit sends the question.
  - Message bubbles: user (blue, right-aligned), assistant (grey), error (red). A "Thinking…" italic placeholder shows while waiting.
  - A collapsible "SQL used" `<details>` block under each answer.
  - Calls `POST /api/db-chat` with a Bearer token.

---

## Page (Android tab only): Stock
**Hash** `#stock`, **source** `src/stock.js`. Not in NAV_CONFIG and always allowed (`native-shell.js` `always:true`).
- [ ] Navy header: ☰, "Stock", refresh button (clock icon, 44px), search input (type=search, `enterkeyhint=search`, "Search by name or item code").
- [ ] Filter button "Available stock" (`aria-pressed`; on = gold fill with navy text and a tick).
- [ ] Search:
  - Debounced 250ms. Every word must match name or alias (one `.or` per word, ANDed), limit 30, then re-checked with `tokenMatch`.
  - Stale responses are discarded via a sequence number.
  - The "Available stock" filter re-queries with `stock_qty > 0`.
- [ ] Freshness line:
  - Latest successful `sync_log` with `job='stock-live'`, falling back to any successful row.
  - Green dot normally; amber dot and "· may be out of date" after 30 minutes.
  - Re-rendered every 30s.
- [ ] Cards:
  - Name; code line "<alias> · Code <code>"; MRP and Sale prices (Sale in bold; MRP is **not** struck through); "No rate set" when neither exists.
  - Stock box:
    - In stock: navy with gold text
    - Nil: red tint
    - Negative: red, showing the real figure
    - Not known: grey "—"
- [ ] States:
  - Skeleton (`stockPulse` 1.1s)
  - Empty prompt "Search for an item by name or code. / Every word has to match, in any order."
  - "No items match "x"." / "Nothing in stock matches "x". Turn off Available stock…"
  - Error "Could not reach the stock data."
- [ ] Tapping a card: background `--line-soft` on `:active`.

---

## Cross-cutting

- [ ] **Theme / dark mode** (`theme.js`):
  - localStorage `darkMode`; `body.dark-mode` class; CSS variable remap at `style.css:32-42`.
  - Exceptions that do not follow the theme: brand gold/navy; the letterhead; the totals bar; Items Management; Control Centre (always dark).
  - In the app, `body.native-app:not(.dark-mode)` swaps in the app palette (navy primary, gold).
- [ ] **Icons** (`icons.js`): inline 24×24 stroke SVGs, `icon(name, size)`. Names: grid, briefcase, building, bolt, file, box, card, chart, users, plus, chevron-right/down/left, clock, check, alert-triangle, menu, user, sun, moon, layers, clipboard, calendar, history, send, chase, ellipsis, pencil, x, truck, arrow-right, backspace. Quotations also uses a filled WhatsApp glyph.
- [ ] **Utils** (`utils.js`):
  - Constants: `PRODUCT_STAGES`, `PROJECT_STATUSES`.
  - Formatting and helpers: `esc`, `slug`, `todayISO`, `parseLocalDate` (local calendar dates), `addDays`, `formatDate` (en-IN), `phoneMatchKey`, `formatMoney` (₹ en-IN), `formatMoneyCompact` (L / Cr above 1 lakh), `numberToWordsIndian`.
  - Links: `telHref` (`tel:+91…`), `waHref` (`wa.me/91…?text=`).
  - `skeletonList(n)`.
- [ ] **Catalog** (`catalog.js`):
  - Module-level caches for `catalog_items`, `model_discount_presets`, `generic_items`, `generic_item_map`, all loaded with `fetchAllRows` (1000-row pages).
  - `clearCatalogCache`, `getPresetDiscount`, `getMapEntriesFor`, and `tokenMatch` (every token must be a substring, any order).
- [ ] **Pagination helpers**: `fetchAllRows` (CRM) and `fetchAllBusyRows` (BUSY), both 1000-row `.range` pages.
- [ ] **Modals** (`.modal-overlay` / `.modal`): bottom sheet below 640px, centred above. 16px radius, max height 90vh, scrolls. No open animation.
- [ ] **Suggestion dropdowns** (`.item-suggestions`): max 240px, shadow, highlighted row `--grn-bg`, 150ms close-on-blur delay, selection on mousedown.
- [ ] **Android / native** (`native.js`, `native-shell.js`, `capacitor.config.json`):
  - The app loads the live site `https://jcm-crm.vercel.app`, with `offline.html` as the error path. App id `com.jcmretails.tools`.
  - `IS_NATIVE` via Capacitor. `apiUrl()` prefixes the absolute origin in the app.
  - Bottom tab bar `.app-tabs`: Tasks, Quotations, Stock.
    - Tabs without permission are shown disabled ("You do not have access to this").
    - Active tab: gold 3px top border, navy text.
    - Tapping the active tab smooth-scrolls to the top.
  - `keyboard-open` class (visualViewport inset above 120px) slides the tab bar away (`translateY(100%)` over 180ms) and zeroes `--app-nav-h`. The real bar height is measured into `--app-nav-h`.
  - Navy header with safe-area padding; title in Inter 17px.
  - 44px minimum touch targets; 16px input font size; 16px card radius.
  - `.app-main > *` fades and rises in (`appScreenIn` 0.18s).
  - Press feedback: scale .97 on buttons; `--line-soft` background on cards and rows.
  - Horizontal scrolling disabled; the quotation sheet is scaled to fit.
  - The pinned sidebar is never mounted; ☰ opens the drawer.
- [ ] **Reduced motion**: Task Board panel and accordion, skeletons and screen fade-in are all disabled under `prefers-reduced-motion`.
- [ ] **Ask AI** (`api/db-chat.js`):
  - Needs `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUSY_SERVICE_ROLE_KEY` and `ANTHROPIC_API_KEY`.
  - Caller must have `profiles.role === 'admin'`. This is **inconsistent** with the Items Management tab being grantable: a non-admin who has been given that tab gets 403 "Admin access required".
  - Schema is cached for 10 minutes via BUSY RPC `run_readonly_query` against information_schema.
  - Model `claude-opus-5` returns structured output (zod `{sql}`). `isSafeSelect` allows only a single SELECT with no DDL/DML. The query runs through the RPC, then a second model call writes a plain-language answer.
  - Returns `{answer, sql}`.
- [ ] **CORS** (`api/_cors.js`): allowlist of localhost / capacitor origins; preflight answered with 204; methods POST and OPTIONS.
- [ ] **index.html**: Google Fonts (Cormorant Garamond, Inter, Playfair Display) and CDN scripts for html2canvas 1.4.1, jsPDF 2.5.1 and qrcodejs 1.0.0.

### Storage keys
- localStorage: `sidebarCollapsed`, `darkMode`, `taskBoardCollapsedStacks`
- sessionStorage: `leadsStatusFilter` (one-shot)

### Gate inconsistencies to keep in mind when checking the rebuild
- Dashboard and most pages compute `isAdmin` from `role === 'admin'`, but only use it for the (now ignored) `openSidebar` argument.
- Admin page client gate is `role`; its API gate is `is_admin`.
- db-chat API gate is `role`.
- Price Update uses `isAdminProfile` (accepts either).

---

## Supabase tables used (table → pages)

### CRM project (`cmtnzmfuasniicsdxyle`)

| Table / object | Used by |
|---|---|
| `profiles` | login/boot (active, allowed_tabs, is_admin, role, name); profile setup/edit; Task Board roster (hide_from_roster); Quotations (sales person); quotation form history line; Manage Users (active toggle, plus via API) |
| `projects` | Dashboard; Project Leads; project form/detail; Architects/Electricians (referral counts and lists); sidebar badges; quotation form (client search, phone match, insert/update status/value/product_category) |
| `project_photos` + storage bucket `project-photos` | Project Leads (thumbnail); project form/detail; contact detail |
| `industry_contacts` | Architects/Electricians; project form comboboxes; Project Leads/detail embeds |
| `notes` | project detail |
| `meetings` | project detail |
| `quotations` | Quotations list/stats; form; view; Dashboard activity; project detail |
| `quotation_items` | Quotations list/stats; form (delete + insert); view |
| `catalog_items` | quotation form (catalog cache); Price Update (read + update) |
| `model_discount_presets`, `generic_items`, `generic_item_map` | quotation form |
| `team_tasks` | Task Board (realtime); sidebar openTasks badge |
| `team_task_history` | Task Board (realtime; insert/delete) |
| `task_card_access` | Task Board |
| `pay_payments`, `pay_feedback` | Payments |
| `user_pins`, `pin_login_attempts` | server only (`api/pin-login.js`, `api/admin-users.js`) |
| `auth.admin` (createUser, updateUserById, generateLink, verifyOtp, getUser) | API functions |

### BUSY project (`jlkjjqnmhsgefpluemyz`)

| Table / view / RPC | Used by |
|---|---|
| `items` | Stock search; Order Planning (avg_rate, stock_source coverage, Item Settings search); Items Management (sale_rate, fixed_value; export) |
| `reorder_suggestions` (view) | Order Planning dashboard; Dashboard Low Stock KPI |
| `reorder_settings` | Order Planning Item Settings (read + upsert) |
| `declutter_candidates` (view) | Order Planning Declutter |
| `sync_log` | Order Planning sync pill (`job='nightly'`); Stock freshness (`job='stock-live'`) |
| `item_groups`, `item_group_map` | Items Management |
| `item_pending_edits` | Items Management (the only BUSY table the app writes, apart from `reorder_settings`) |
| `v_monthly_revenue`, `v_daily_revenue`, `v_top_customers`, `v_sales_by_group`, `v_top_items`, `v_dues_summary`, `v_dues_by_route`, `v_stock_by_group` | Control Centre |
| RPC `run_readonly_query` (service role) | `api/db-chat.js` (Ask AI) |
| `item_sales_history` | not read directly by the app (feeds the views) |

### API endpoints

| Endpoint | Called from |
|---|---|
| `POST /api/pin-login` | `login.js` |
| `POST /api/admin-users` (actions list / create / update) | `admin.js` |
| `POST /api/db-chat` | `items-management.js` |