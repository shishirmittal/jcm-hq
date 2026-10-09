# JCM Orders: feature inventory for re-hosting

Repo: `/home/claude/jcm-orders`. I read every file in `src/` and `api/` in full, plus `CLAUDE.md`, `vercel.json`, `index.html` and all of `supabase/*.sql`. I skimmed `busy-sync/sync-orders.js` (header, plan logic, apply, run, keep-warm) and read `busy-sync/print-agent.js` almost in full. No files were changed.

**Global facts that apply to every page**
- Router is `src/App.jsx:36-39`:
  - `/board` → Board, `/admin` → Admin, `/owner` → Owner, `/logs` → Logs.
  - **Any other path** → Tablet. A trailing slash is stripped.
  - `vercel.json` rewrites every non-`/api/` path to `index.html`.
- Every page is wrapped in **SafetyNet** (`App.jsx:11-28`), an error boundary drawn with inline styles only:
  - Title "This page hit a problem", the text "Reload the page. If it keeps happening, send Claude a photo of this message.", the error message in Consolas, and a navy **Reload** button.
  - It logs `console.error('JCM Orders page error:', …)`.
- Font: Roboto Condensed (weights 400–900) and Noto Sans Devanagari (500, 700) from Google Fonts (`index.html`). `theme-color` is `#12213B`. Favicon is `/jcm-logo.png`. React is in StrictMode.
- CSS variables (`styles.css`): `--navy #12213B`, `--ink #0C111B`, `--gold #D9AE55`, `--light #F6F3EC`, `--muted #3E4553`.
- The browser only calls `/api/*`, through `src/lib/api.js`:
  - Uses `cache:'no-store'`.
  - Sends the `X-Device-Token` header when there is a device key and `Authorization: Bearer` when there is a session.
  - Returns `{ok,status,data}` and never throws on a non-JSON reply.
- localStorage / sessionStorage access is guarded (`src/lib/storage.js`), so blocked storage fails quietly.
- **Every hover, active, focus and animation in the whole app:**
  - **No CSS `transition` exists anywhere.** Every state change is instant.
  - Only three `@keyframes`: `tvloop` (`board.css:5`), `tb-spin` (`tablet.css:399`), `jo-spin` (`admin.css:220`).
  - Tablet and TV are touch screens: they use only `:active`. There are no `:hover` rules in `tablet.css` or `board.css`.
  - Desktop hovers exist only in `admin.css` and `logs.css`. Each is listed under its page below.
- Class prefixes: `tb-` tablet, `tv-` board, `jo-` admin/owner/logs, `lg-` logs.
  - **Never** use class names `ad`, `ad-…`, `ads…`, `advert…`, `banner…`, `sponsor…`. Ad blockers hide them; this once blanked `/admin`.

---

## Page: Staff tablet / phone (`/`, `src/pages/Tablet.jsx`, `src/lib/tablet-logic.js`, `src/tablet.css`)

### Access and sessions
- [ ] **Device key.** It is read from localStorage `jcmOrders.deviceToken`.
  - No key → "unregistered" screen.
  - Any API reply `401 {error:'not_registered'}` → unregistered screen (`Tablet.jsx:58`).
  - The device must be registered on /admin as type "Staff tablet". Phones are registered the same way.
- [ ] **Staff sign-in.**
  - Tap a name tile, then type a 4-digit **CRM PIN**. It **auto-submits at the 4th digit** (`PIN_LENGTH 4`, `:376-378`).
  - Call: `POST /api/tablet {op:'login', profileId, pin}`.
  - Reply: `{token, profile, expiresAt, me, orders, materialCount}`. The home lists come back in the same answer, so no second call is made.
- [ ] **Server session rules.**
  - 15-minute sliding session, bound to this device (`staff_sessions`). Expiry is pushed forward at most once a minute.
  - Sessions are cached 30 s per server instance.
  - The device and the roster are always read fresh, so switching a device off or removing a person works at once.
- [ ] **Wrong-PIN lockout.** 5 wrong PINs per device per 15 min → 429 "Too many wrong PINs on this tablet. Wait 15 minutes." Attempts are stored in `orders_login_attempts` with ip = `device:<id>`.
- [ ] **Login is refused (403 "This person is not on the tablet list.")** when the person is not in the roster or is inactive.
- [ ] **60-second idle lock in the UI.**
  - Any `pointerdown` or `keydown` resets it (`:111-125`).
  - The header shows "Locks in M:SS" (tabular figures).
  - At 0, `lock()` runs: fire-and-forget `POST {op:'logout'}`, all state cleared, back to the name tiles.
  - The PIN screen also returns to the tiles after 60 s idle (`:127`).
- [ ] **Camera hold.** While the camera or gallery picker is open, the lock is paused for up to 5 min (`CAMERA_HOLD_MS`). On window `focus`, or when the file input changes, the hold ends and the idle minute restarts (`:116`, `:145`).
- [ ] **Switch user** button in the header calls the same `lock()`.
- [ ] **Any 401 from a staff call** → `lock()`.
- [ ] **localStorage `jcmOrders.roster`** caches the last name tiles, so they show instantly while the roster refreshes (`:20-21`, `:72`).

### Phone vs tablet layout
- [ ] **Tablet.** Fixed 1280×800 design, scaled to fit with `useFit(1280,800)`:
  - `transform: translate(x,y) scale(s)`, `transform-origin 0 0`, letterboxed on `#0C111B` (`src/lib/useFit.js`).
  - It recalculates on window `resize`.
- [ ] **Phone.** Used when `innerWidth < 760` **or** the screen is portrait (`innerHeight > innerWidth`), checked live on resize (`:25-34`).
  - Adds class `.tb-phone`: real-size CSS, no scaling (`tablet.css:205-423`).
  - Smaller fonts, single-column cards, steps strip hidden, chevron hidden, role label hidden.
  - Stacked bottom buttons, `env(safe-area-inset-bottom)` padding.
  - Sheets are not dimmed; `max-height: calc(100% - 60px)` with scroll.
  - Facts grid becomes 2 columns. The material row turns into stacked grid areas.
- [ ] **Stage.** `.tb-stage` is fixed full screen, navy-black background, `touch-action: manipulation`, `user-select: none` (inputs re-enable text selection).

### Screens (state machine `screen`)
`unregistered`, `tiles`, `pin`, `home`, `list`, `order`, `material`, `boxes`, `labels`, `reprint`, `ask`, `lrsource`, `photo`.

- [ ] **Unregistered** (`:301`)
  - 120 px logo; heading "This screen is not registered".
  - Instructions naming orders.jcmretails.com/admin and type "Staff tablet".
  - Links "Admin page ›" and "TV board ›".
- [ ] **Name tiles** (`:312`)
  - Header (104 px): 72 px logo, "JCM Orders", and a live clock "3:45 pm · Fri 10 Oct" in IST, refreshed every 1 s.
  - "Tap your name"; a 4-column grid of 244 px tiles (2 columns × 150 px on a phone).
  - Each tile: 104 px navy circle with gold initials, and the name.
  - `:active` → background `#F3EBD9`, gold border.
  - States: "Loading…"; empty "No staff are set up for the tablet yet…"; error line with a **Try again** link.
  - Call: `GET /api/tablet?op=roster`. It reloads every time the tiles screen shows.
- [ ] **PIN** (`:352`)
  - Left side: "‹  Not {first name}?" outline back button, 140 px initials circle, name at 72 px, "Enter your 4-digit CRM PIN".
  - 4 dots of 40 px: grey ring when empty, navy filled when typed.
  - Right side: 520 px keypad `1–9, Clear, 0, ⌫`. Function keys are smaller with a beige background. `:active` → `#F3EBD9` + gold border.
  - **Wrong PIN:**
    - All dots turn red.
    - Red-ruled message: "That PIN is wrong." and "Try again, or ask an admin to reset it in the CRM."
    - Input is blocked for 2 s, then cleared (`:362-364`).
  - Other errors show a line and clear the PIN.
  - Keys are ignored while busy or wrong (double-tap guard).
- [ ] **Shell header** on signed-in screens (`:407`)
  - 88 px navy bar: 56 px gold-ring initials, first name, optional "Admin" role label (only on order, material and boxes screens; hidden on phone).
  - Gold "Locks in M:SS" and the **Switch user** button (gold outline).
  - The sheet screens (labels, reprint, ask, lrsource, photo) are *not* inside Shell. They show a dimmed `.tb-sheethead` (opacity .7) with initials and first name. The lock still runs.
- [ ] **Home: job cards** (`:425`, `T.homeCards`)
  - One card per job ticked for the person; admins see all of them:

    | Card | Shown for job | Sub-line | Top colour |
    |---|---|---|---|
    | NEW | pick | "to pick" | `#D98E2B` |
    | PICKING | pick | "waiting for invoice" | `#2E7D5B` |
    | INVOICED | check | "to check" | `#2F5FA3` |
    | READY FOR DISPATCH | ready or dispatch | "N to pack · M to dispatch" ("to pack" only with the ready job) | `#12213B` |
    | PENDING MATERIAL | material | "items to order" | `#9A5F10` |

  - Grid columns: 1 card = 1 column; 2 or 4 cards = 2 columns; 3 or 5 cards = 3 columns. Phone: always 1 column, horizontal card layout.
  - Card: 12 px top border in the stage colour; 34 px title; count at 120 px (stage colour, grey `#8A8F99` when 0, "—" when null); sub-line; "oldest 1h 20m" or "nothing waiting" (blank on material).
  - `:active` → `#F3EBD9`.
  - Error and notice lines show above the cards.
  - Empty: "No jobs are ticked for you yet…".
  - The PENDING MATERIAL count = open `procurement` rows with `ordered_at` null.
- [ ] **Stage list** (`:448`)
  - Top: "‹  All jobs", coloured title, "N · oldest first". Sorted by `stageSince` ascending.
  - **Search box:** 72 px, placeholder "Search party name". It also matches **city and SO number**, any case (`T.searchOrders`). Gold 3 px focus outline. The native webkit cancel button is hidden. A **Clear** button appears while there is text. The search text resets when you leave the list.
  - **Order card** `.tb-ocard`:
    - 8 px left border in the stage colour.
    - Name 48 px; city.
    - Meta: "SO 754 · Invoice Godrej/6189 · 3 lines" (invoice only after picking), otherwise "SO 754 · 5 Oct · 3 lines". PICKING cards add " · {picker first name}".
    - Return tag `.tb-arrived` (amber):
      - stock: "Stock arrived 5 Oct — pick today"
      - manual: "Pick anyway — send what is in stock (5 Oct)"
      - date: red: "Expected 10 Oct — not in Busy stock yet. Check and pick today"
    - Stage badge, e.g. NEW, PICKING, INVOICED, CHECKED, "READY · 3 BOXES". NEW has dark text; the others white.
    - Stage timer (2m / 1h 05m / 1d 03h); chevron ›.
    - `:active` → `#F3EBD9`.
  - Empty states: "Nothing here right now. New orders appear by themselves." and "No party matches “q”."
  - The READY card list holds checked orders (ready job only) plus in_bay orders (ready or dispatch job).
- [ ] **Order screen** (`:494`)
  - Top: "‹  Back"; **REPRINT LABELS** (in_bay only); step pills New · Picking · Invoiced · Checked · Ready.
    - Done steps: "✓ X" in navy outline. Current step: filled in the stage colour. Future steps: grey. Hidden on phone.
  - Card: name 72 px, city, meta ("Ordered 5 Oct" form).
  - **Stock chip** "12 lines · 2 short" (red) or "12 lines · all in stock" (green), with "See items ↓". Tapping it smooth-scrolls to `#tb-items` (`:531`).
  - Return tag, large badge, who line:
    - "Not assigned yet" / picker name / "Picked by X" / "Checked by X" / "Packed by X".
  - "in this stage" with a 40 px timer.
  - Helper paragraph per stage (`T.helper`).
  - **Item list:** head "Items" + summary (red when short). One row per line:
    - Name and "Code 1234", qty.
    - Marker pill: green **In stock**; red **Short: 3 of 5** with small "2 in stock" / "none in stock"; grey **Cleared** (name and qty struck through); grey **Billed**.
    - "loading…" while loading; "No item lines on this order."
  - Detail call: `GET /api/tablet?op=order&id=`. It refetches when stage or stageSince changes (`useDetail`, `:787`).
  - **Order gone** (no longer in my lists): "This order is no longer open / It may have been moved on by someone else, or changed in Busy.", or the ok notice.
  - **Bottom button**, one main button (`T.action`), 120 px, 40 px bold text:

    | Stage | Button | Style | Job needed / disabled text |
    |---|---|---|---|
    | new | I'M PICKING THIS | primary navy, `:active #0C111B` | pick; else "NOT YOUR JOB" |
    | picking | WAITING FOR INVOICE | disabled | — |
    | invoiced | CHECKED AGAINST INVOICE | primary | check; else "CHECKER CHECKS THIS" |
    | checked | READY FOR DISPATCH | primary, opens the boxes screen | ready; else "BEING PACKED" |
    | in_bay | UPLOAD LR | confirm green, `:active #245F46`, opens LR source sheet | dispatch; else "DISPATCH PERSON SENDS THIS" |

    - Disabled or off style: grey background with a dashed border.
    - NEW + pick job: a second button **WAIT FOR MATERIAL** (outline, 72 px; the main button shrinks to 108 px).
    - in_bay: a second button **Dispatch without photo** (outline, 1/3 width).
    - The main button shows "SAVING…" while its handler runs (brief: it only opens a sheet).

### Confirm sheet: every saving action (`Confirm`, `:596`; `askFor`, `:186`)
- [ ] **Look**
  - Grey backdrop `#3A4252`, dimmed header.
  - White sheet: top corners radius 28, 6 px navy top border.
  - Party name 56 px; one line 30 px; optional extra block; error line.
  - **CANCEL left / CONFIRM right**, each up to 440 px wide, **160 px gap** (40 px on phone).
- [ ] **On CONFIRM**
  - **Spinner** (`.tb-spin`, 28 px ring, `tb-spin .8s linear infinite`) with "SAVING…".
  - Both buttons are disabled until the server answers; a `busy` guard blocks double taps.
  - A server refusal is shown on the sheet as `notice.error`.
  - CANCEL returns to the screen the sheet came from (`ask.back`: order, boxes or material).
- [ ] **Actions**

  | Action | Line | Confirm label | Op | Optimistic? | Afterwards |
  |---|---|---|---|---|---|
  | Pick | "Start picking X? It moves to PICKING with your name on it." | YES, I'M PICKING | `pick` | yes | back to the order screen |
  | Check | "Mark X as checked against invoice INV?" | YES, CHECKED | `check` | yes | order screen if the person has the ready job; otherwise back to the list with ok "X checked against the invoice." |
  | Wait | "Move X to Waiting for material? It leaves the NEW list…" | YES, WAIT | `wait` | yes (removed from list) | list, ok "X (SO 754) is waiting for material." |
  | Ready, skip labels | "Mark X ready… WITHOUT labels?" | YES, NO LABELS | `ready {boxes, labels:'skip'}` | yes | order screen, ok "…labels skipped. Tap REPRINT LABELS if you need them later." |
  | Ready, print labels | "…and print N labels?" | YES, PRINT N | `ready {boxes, labels:'print'}` | yes | Labels sheet |
  | Dispatch without photo | "Mark X as dispatched, WITHOUT an LR photo (self-pickup)?" | YES, DISPATCHED (green) | `dispatch` | **no** | list |
  | Tablet MARK ORDERED | "Mark ITEM as ordered, arriving in N days?" | YES, ORDERED | `material_ordered {id, days}` | **no** (see note) | material screen |

  - **Wait extra block** (`ShortItems`): "Short in Busy: Item A (short 3 of 5), …", or "Busy shows stock for every line (…), so it will come back to NEW at the next sync, within 3 minutes."
  - **Dispatch-without-photo extra block** (`DispatchFacts`):
    - 4 facts: Boxes / Items (lines, pieces) / Pending (amber) / Total amount incl. GST in ₹ (en-IN format).
    - Pending list.
    - WhatsApp note: "WhatsApp goes to +91 98xxx xxxxx …", or "not switched on yet", or "no valid mobile number".
  - **After a dispatch:** ok notice "X dispatched. WhatsApp sent to the customer." / "The WhatsApp could not be sent — it is noted on the order." / "No WhatsApp sent (switched off, or no mobile number)."
  - **Tablet MARK ORDERED note:** `CLAUDE.md` says it is optimistic, but the code is not. `T.markItemOrdered` exists and is unused. After saving, the Material screen remounts and reloads.
- [ ] **Optimistic engine** (`doMove`, `:157-174`)
  - `T.applyMove` changes the order list at once.
  - A refusal or lost connection rolls back and shows "Not saved — {reason}".
  - `moves.inFlight` / `seq` make the 15-s refresh ignore answers while a tap is in flight or after one happened.
  - Every move answers with the fresh home lists (`takeHome`).

### Packing and labels
- [ ] **Boxes screen** (`:687`)
  - "How many boxes?", "Name · City", 260×180 number box at 140 px ("–" when empty), "One label prints for each box."
  - Same keypad. At most 2 digits; leading zeros stripped. The server checks 1–99.
  - Bottom (2fr / 1fr): **PRINT N LABELS** (green) / **SKIP LABELS** (outline). Both disabled until there is a number; text "ENTER THE NUMBER OF BOXES" until then.
  - Either button opens the Confirm sheet. The labels sheet never sends by itself.
- [ ] **Labels sheet** (`:730`)
  - Gold top border.
  - Polls `GET /api/tablet?op=label_job&id=` **every 1.5 s, gives up after 3 min**. Giving up shows "The printer has not answered for 3 minutes. Check that JCM-Server and the label printer are on, then tap REPRINT."
  - Status line with a dot: green "N LABELS PRINTED" / amber "PRINTING…" / red "LABELS NOT PRINTED".
  - Title: "N labels printed — stick one on each box" / "Printing N labels…" / "The labels did not print".
  - Sub-line: name, city, plus " · boxes 2, 5 of 7" for a partial reprint.
  - Slow note when the job has been queued over 30 s: "Still waiting for the print agent on JCM-Server…"
  - Printer error text when it failed.
  - Up to 8 mini label tiles, 130×180: "BOX / n / OF N".
  - Buttons: **REPRINT** (disabled while printing) and **DONE** (back to the list). Keyed by job id, so it remounts for each job.
- [ ] **Reprint sheet** (`:640`)
  - "Reprint which labels? Tap the boxes (each prints “n of N”)."
  - **All** toggle plus 96 px toggles "**n** of N". On = navy fill; `aria-pressed`. The grid fills 150 px columns, max height 330 px, scrolls.
  - Button "PRINT N LABEL(S)" / "CHOOSE BOXES" (disabled when nothing is chosen); spinner "SENDING…".
  - Call: `POST {op:'print_labels', id, reprint:true, boxNumbers?}`. `boxNumbers` is left out when All is chosen.
  - Error "This order has no box count yet."; then the Labels sheet.

### LR photo and dispatch
- [ ] **UPLOAD LR source sheet** (`:831`)
  - Two large buttons: **TAKE PHOTO** (primary) and **FROM GALLERY** (outline). Only **CANCEL** below them.
  - Hidden inputs: `<input type=file accept="image/*" capture="environment">` and a second input without `capture` (`.tb-gallery`). They are 1 px, opacity 0, off-screen (`:292-293`).
- [ ] **Photo shrinking** (`src/lib/photo.js`)
  - Long side 1600 px, JPEG 0.8. If still too big: 1280 px / 0.7, then 1024 px / 0.6.
  - Limit about 3.6 M base64 characters. Otherwise "The photo is too large. Take it again." A non-image gives "This file is not a photo the browser can open."
- [ ] **Photo sheet** (`:855`)
  - Header button **RETAKE**, or **CHOOSE AGAIN** for gallery photos, top right.
  - Full-height sheet: "Name, City" (40 px), "Upload LR and mark X dispatched?", the photo on black with `object-fit: contain`.
  - Facts line: "N boxes · n lines (p pcs) · k pending (amber) · ₹total", then the WhatsApp note.
  - **CANCEL** / **SEND** (green), spinner "SENDING…".
  - SEND → `POST {op:'dispatch', id, photo:<dataURL>}`. Not optimistic.
  - On the server the photo is saved first. If saving fails: 502 "The photo could not be saved, so the order was NOT dispatched…" and nothing moves.

### Pending material screen (`:892`)
- [ ] Opened from the home card "PENDING MATERIAL". Title "Pending material", sub-line "Items open orders need beyond the stock in Busy".
- [ ] Call: `GET /api/tablet?op=material`.
- [ ] Groups by supplier (`supplier_name`, else item group, else "Other"), with an item count.
- [ ] Row: 8 px left border **red** when not ordered, **amber with a tinted background** when ordered and late. Shows item; "short N"; party names; status "Ordered 6 Oct · expected 10 Oct — late" / "Not ordered".
- [ ] **MARK ORDERED** (primary) or **Change date** (outline) → inline choice "2 days / 4 days / 7 days" + Cancel link → Confirm sheet.
  - No date picker on the tablet. No Undo on the tablet (the server has `material_unordered`, but there is no button for it).
- [ ] States: "Loading…", "Nothing to order — stock covers every open order.", error line. Only the ok notice is shown here; errors appear on the Confirm sheet.

### Refresh and timers
- [ ] Order lists refresh every **15 s** (`GET /api/tablet?op=orders`). The first fetch is skipped if the lists are under 5 s old.
- [ ] Load failure: "No connection to the server — showing the last list. It retries by itself."
- [ ] Clock and timers tick every **1 s**.

---

## Page: TV board (`/board`, `src/pages/Board.jsx`, `src/lib/board-logic.js`, `src/board.css`)

### Access and refresh
- [ ] **Device key** from localStorage `jcmOrders.deviceToken`. Missing, or any 401 → "This screen is not registered" (gold rule, 64 px heading, instructions).
- [ ] Device must be `active`. `last_seen_at` is updated at most once a minute (`api/_lib/auth.js:41-54`).
- [ ] `GET /api/board` **every 15 s**.
- [ ] Server clock skew is corrected: `now = Date.now() + (server now − client now)`.
- [ ] A local tick **every 10 s** redraws timers and checks staleness.
- [ ] **Loading state:** "Loading orders…", or when there is a problem: "**{problem}** / Trying again every 15 seconds."
  - Problems: "The server is not set up yet (database settings missing in Vercel).", "The server did not answer properly (code N).", "No connection to the server."
- [ ] **Connection lost:** after a good load, if there is no success for over **60 s**, a red strip (56 px, bottom, full width) shows "Connection lost — showing orders from 3:45 pm". The last good data stays on screen.

### Layout
- [ ] Fixed **1920×1080**, scaled to fit with `useFit`, black letterbox. Tabular figures throughout.
- [ ] **Header** (99 px navy, 3 px gold bottom border):
  - 68 px logo.
  - Clock "3:45 pm" (48 px white) and day "Friday, 10 October" (gold) in IST.
  - Counters **Open / Dispatched today / Waiting**, each separated by a gold-tinted left rule.
  - **BUSY SYNC** marker: dot plus "3:42 pm · 3 min ago". Green dot `#3FB37F`; **amber** dot and text when over 10 min old or never seen ("not yet").
    - Source: the latest `orders_sync_log` row with status success.
- [ ] **5 columns** (`COLUMNS`, `board-logic.js:10`), each headed by a 6 px top border, title (ellipsis), count, location line:

  | Column | Colour | Location line |
  |---|---|---|
  | NEW | `#D98E2B` | — |
  | PICKING | `#2E7D5B` | Dispatch tables |
  | INVOICED / CHECKING (invoiced + checked) | `#2F5FA3` | Dispatch tables |
  | READY FOR DISPATCH (in_bay) | `#12213B` | Dispatch bay |
  | WAITING FOR MATERIAL | `#8A8F99` | — |

- [ ] **Display settings** come with every refresh from `orders_config` key `tv_display` (`layoutFor`):
  - `cardsPerColumn` 3–7: 3 = Large, 4–5 = Medium, 6–7 = Compact.
  - `textScale` 0.8–1.4. Base font sizes (name / mid / small): Large 40/30/22, Medium 30/24/20, Compact 24/19/17.
  - `scrollSpeed` slow / normal / fast = 16 / 26 / 40 px per second.
  - `lateStyle` timer | edge.
  - `showRefs` on/off.
  - Defaults when missing: 3 cards, 100%, normal, timer, refs on.
  - Card height = floor((852 − (n−1)·gap) / n). Gap 14 (Compact 8).
  - **There is no admin UI for these settings yet** ("TV display tab" not built). Change them in the DB, or in the dev server via `/__tv-display?…`.
- [ ] **Cards** (`Card`, `Board.jsx:147`)
  - Large: refs row "SO 754 … Godrej/6189"; name (2-line clamp); filler; "N lines" + tag; footer rule with created "5 Oct · 3:45 pm" and timer.
  - Medium / Compact: name; row "lines · tag · timer"; meta "created · invoice (else SO)".
  - Normal card: white, 1 px `#E4DED0` border.
  - **Late** = longer in its stage than `thresholds[stage]`:
    - Timer turns red `#C2452D`.
    - With `lateStyle` edge, also a **6 px red left border**.
- [ ] **Tags** (`tagFor`):
  - NEW: **STOCK IN** / **DUE TODAY** (red) / **PICK ANYWAY**, from `grown_reason`.
  - PICKING: picker first name in capitals.
  - INVOICED: "INVOICED", or "✓ NAME" / "✓ CHECKED" for checked orders.
  - READY: "N BOXES" / "READY".
- [ ] **Waiting cards** (id `<order>#waiting`):
  - Dashed border `#B5B0A5`, background `#EFEDE8`.
  - "N pending"; tag **NOT ORDERED** (red) / **ORDERED** / **IN STOCK** (grey `#4A505C`).
  - Created line: "Exp. Fri 10 Oct" when ordered, else the created time.
  - Timer = time waiting, never red.
  - Only red and green parties from `materialOverview`. Amber (floor) parties are excluded.
- [ ] **Sorting** (`api/board.js:96`): oldest `stage_since` first. Waiting column: no expected date (red) first, then soonest expected date.
- [ ] **Auto-scroll** when a column has more cards than `cardsPerColumn` (`buildColumns`):
  - The list is doubled, with a marker "— TOP OF LIST · N —" (gold lines) before each copy.
  - CSS animation `tvloop {Math.round(cycle/speed/0.9)}s linear infinite`. It holds at 0 for the first 10%, then moves up by `--cycle` (= 48 + gap + n·(cardH + gap)).
  - The list is faded top and bottom with a `mask-image` gradient (top 20 px, bottom 56 px).
- [ ] **Empty column:** dashed box 120 px high, "No orders".
- [ ] **All clear:** when `open == 0` and `waiting == 0`: gold rule, "All clear" (180 px), "No open orders on the floor.", "N orders dispatched today" (green).

### Data
- [ ] Endpoint `GET /api/board` (`api/board.js`). Reads:
  - `devices`, `orders_config` (`threshold_minutes`, `tv_display`).
  - `orders` (open; `grown_reason` read tolerantly).
  - `order_events` (dispatched since IST midnight → "Dispatched today", counted as distinct orders).
  - `materialOverview`, `orders_sync_log`, `profiles` (first names).
- [ ] Reply: `{now, device, thresholds, display, lastSyncAt, counters{open, dispatchedToday, waiting}, cards[]}`.
- [ ] `orders.hidden_until` is ignored everywhere.

---

## Page: Admin (`/admin`, `src/pages/Admin.jsx`, `src/admin.css`)

### Sign-in and session (shared by /admin, /owner, /logs)
- [ ] **Form** (`SignIn`, `:57`): "Sign in"; "Use the same PIN you use for the CRM…".
  - Password field `inputMode=numeric`, digits only, up to 8, autofocus, 28 px font with wide letter spacing.
  - Button "Sign in" / "Checking…", disabled under 4 digits. An error clears the PIN.
- [ ] **Call:** `POST /api/admin/login {pin}`.
  - Looks the PIN up in **CRM `user_pins`** (plain text, read only), then `profiles`.
  - Must be an admin (`is_admin` true or `role = 'admin'`, and active).
  - 5 wrong PINs per IP per 15 min → 429. Attempts are kept in `orders_login_attempts`.
  - Creates an `admin_sessions` row, **30 min, not sliding**.
  - Housekeeping in the same call: deletes expired sessions and attempts older than 1 day.
  - Error texts: "That PIN is wrong.", "Only an admin can open this page."
- [ ] **Client session** stored in **sessionStorage** `jcmOrders.adminSession` = `{token, name, expiresAt}`.
  - Expiry is checked on page load. Any 401 → signed out.
  - Shared by /admin, /owner and /logs, within the same browser tab only (sessionStorage).
- [ ] **Header** (76 px navy, 3 px gold bottom border):
  - 48 px logo, "JCM Orders", "Admin".
  - Links "Owner page ›", "Logs ›" (gold, no underline).
  - "Signed in as {name}" and a **Sign out** link.
  - On a phone (≤760 px) the header wraps.

### Sections (one page, stacked cards, max width 1040)
The design's "TV display" tab is **not built**.

1. [ ] **This screen** (`ThisScreen`, `:221`)
   - Text depends on whether this browser already has a key.
   - NAME field (default "Warehouse TV", max 60) and TYPE select (TV board / Staff tablet).
   - **Register this screen** / "Registering…" → `POST /api/admin/devices {name, kind}` → saves the token in localStorage `jcmOrders.deviceToken`.
   - If storage is blocked: "This browser will not save the key (private window…)".
   - Ok: "Registered as “X”." plus an "Open the TV board ›" link. An "Open the TV board" outline button appears whenever a key exists.
2. [ ] **Registered screens** (`Devices`, `:265`)
   - Table: NAME / TYPE / REGISTERED / LAST SEEN ("Never") / STATUS (green "On" / grey "Switched off") / **Switch off** or **Switch on** link.
   - Call: `PATCH /api/admin/devices {id, active}`. Not optimistic; the list reloads after.
   - "None yet.", Loading, error with Try again.
3. [ ] **Tablet staff** (`TabletStaff`, `:354`)
   - Table of every active CRM profile: name plus email, **On tablet** checkbox, job ticks **Pick / Check / Ready for dispatch / Dispatch / Pending material**.
   - Admins show "Admin — every job" instead of ticks.
   - Ticks are disabled while On tablet is off. A person newly put on the tablet starts with Pick.
   - On a phone the job labels show inline.
   - **Save tablet staff** → `POST /api/admin/settings {tabletStaff:{staff, access}}` → `orders_config.tablet_staff`. Ok text: "Saved. The tablet shows the new list the next time it goes back to “Tap your name”."
   - Legacy config (`supervisors`, no `access`) maps to pick/ready/dispatch, plus check for supervisors (`api/_lib/staff.js:38-42`).
4. [ ] **Stage time limits** (`Limits`, `:298`)
   - Rows: New / Picking / Invoiced / Checked / Ready for Dispatch, each with a hint, a numeric input, and "min = 1 h 30 min".
   - **Save time limits** → `POST /api/admin/settings {thresholds}`. Each value 1–10080. Ok text: "Saved. The TV board uses the new limits within 15 seconds."
   - Defaults: new 60, picking 90, invoiced 30, checked 30, in_bay 1440.
5. [ ] **Carton label** (`CartonLabel`, `:122`)
   - Language toggle **English + Hindi** / **English only** (filled = current, `aria-pressed`). Optimistic, with rollback. Call: `POST /api/admin/hindi {op:'language'}`.
   - **Hindi names:**
     - Before the phase 10 SQL has run: "Not set up yet: run supabase/phase10-label-hindi.sql…".
     - Summary "N stored · K need review · M not made yet".
     - **Make the missing ones now (40 at a time)** / "Making…" → `{op:'generate'}`. Ok: "Made N Hindi spellings (F could not be made…)". Shows the first 4 missing names.
     - Filter buttons **Needs review (n)** / **All (n)**, plus a search box (matches English or Hindi).
     - Row (amber left border and tint when it needs review): English name, "City/Party · typed / made by computer", Devanagari input (Noto Sans Devanagari), state "needs review" / "checked".
     - **Save** appears when the text changed → `{op:'save'}` (optimistic). Otherwise **Looks right** → `{op:'accept'}` (optimistic).
     - Failure: "Not saved — …" and rollback.
6. [ ] **Close old orders** (`CloseOld`, `:426`)
   - "OLDER THAN (DAYS)", default 30, allowed 1–365.
   - **Check how many** → `POST {closeOld:{days, confirm:false}}` → red-ruled preview: "N open orders dated before 5 Sep will be closed, for example: …" (8 examples).
   - Then **Yes, close N orders** (red, "Closing…") / **Cancel**.
   - Confirming sets the orders to dispatched, closed, `closed_reason closed_by_admin`, with event `closed`. Ok text: "Closed N orders. They leave the TV board within 15 seconds."
   - Editing the number clears the preview.

### Hover, focus and responsive (admin.css; also used by /owner and /logs)
- [ ] `.jo-btn:hover` → `#1E3256`; `.jo-btn-outline:hover` → `#EEE8DA`; `.jo-btn-danger:hover` → `#A33822`; `.jo-link:hover` → colour `#9A7428`.
- [ ] `.jo-input:focus` → 2 px gold outline. Disabled buttons and links: opacity .5–.55, default cursor.
- [ ] Phone breakpoint 760 px: tables collapse to 2 columns and their headers hide.
- [ ] Error and ok lines: 4 px red or green left rule. Every failed call shows a message; nothing fails silently.

---

## Page: Owner (`/owner`, `src/pages/Owner.jsx`, `src/lib/owner-logic.js`, `admin.css`)

### Access and refresh
- [ ] Same admin PIN session and SignIn as /admin.
- [ ] Header: "Owner", links "Logs ›" and "Admin ›", **Sign out** (no "Signed in as").
- [ ] Data: `GET /api/admin/owner` → `{today, parties, items}` (`materialOverview`).
- [ ] **Auto-refresh** every **60 s**, and also on `visibilitychange`. It is skipped when:
  - the tab is hidden, or
  - a save is running, a confirm is open, or the date chooser is open, or
  - anything is ticked, or
  - the page was touched (`pointerdown`) in the last **20 s** (`IDLE_REFRESH_MS = 20000`; `CLAUDE.md` says 60).
- [ ] A full reload re-sorts and drops greyed rows, and prunes ticks that are no longer listed.
- [ ] **Tabs** **Parties waiting (N)** / **Items to order (N)**:
  - Count pill: navy when the tab is active, beige otherwise.
  - Active tab: gold 4 px underline.
  - Choice stored in localStorage `jcmOrders.ownerTab`. Switching tabs saves it, clears the message and reloads.
- [ ] Page bottom padding is 120 px so the bulk bar never covers content.

### Tab 1: Parties waiting
- [ ] Summary: "N orders with short items — r waiting, not fully ordered (red) · a still in NEW or picking (amber) · g ordered or stock in (green). Tap a party for the full order." Empty: "No order is short of material."
- [ ] Select bar: **Select all (N)**, **Red (n)**, **Amber (n)**, **Green (n)**. Bands with no rows are hidden. Checkboxes are 24 px with `accent-color` navy.
- [ ] **Bands and sort:** red → amber → green, then SO date, then name (`material.js:149`).
  - Red: waiting, not every short item ordered.
  - Amber: still in NEW or PICKING with a short item (the item has an open procurement row).
  - Green: every short item ordered, or stock covers it.
- [ ] **Party row** `.jo-party`: 8 px left border red / amber / green; `.jo-party-picked` adds an inset navy 2 px ring when ticked.
  - Checkbox, then a head button (`:hover` → `#FBF8F1`):
    - Name · city.
    - "SO 754 · ordered 5 Oct · inv X / not billed yet".
    - Amber rows: "Not picked yet / Being picked · not every short item ordered / short items ordered".
    - Other rows: "Waiting since 5 Oct · {Partial invoice | Wait for material button | All lines short (system)} — who".
    - State pill: amber "IN NEW · 2 of 9 short" / "PICKING · …"; red "NOT ALL ORDERED"; green "EXPECTED 10 OCT — LATE" or "STOCK IN".
    - Chevron ▸ / ▾.
  - Pending lines, each: item / "short x of y" / status coloured (red "Not ordered", green "Ordered · exp. 10 Oct", blue "In stock") / **Clear** button.
  - Action row:
    - **Wait for material** (`canWait`, NEW only).
    - **Pick anyway** (`canPickAnyway`, waiting or dispatched).
    - **Clear all short** (amber, more than 1 short line) or **Clear all pending** (more than 1 live line).
- [ ] **Expand** → `GET /api/admin/owner?order=<id>`:
  - Lines table ITEM / ORDERED / BILLED / SHORT. Cleared lines are grey with "— cleared 3 on 5 Oct".
  - **History list**: "5 Oct · 3:45 pm · Event text — who · note" (`EVENT_TEXT`, `eventNote`, `:392-412`).
  - Refetches when the number of live lines changes.
- [ ] **Rows never move while you work** (`owner-logic.js`):
  - A row that leaves the list stays where it is, at 50% opacity, with a grey pill showing why: "CLEARED", "BACK TO NEW", "DONE".
  - Its buttons keep their space but are hidden (`visibility:hidden`).
  - Its lines are struck through ("Cleared").
  - `mergeStable` keeps the on-screen order when the server answers; new rows are added last.

### Tab 2: Items to order
- [ ] Summary: "N items not ordered yet. What open orders need beyond the stock in Busy, by supplier…" Empty: "Nothing to order — stock covers every open order."
- [ ] **Select all (N)**. Supplier groups: header with a supplier checkbox (selects that group) and "N items".
- [ ] **Item row:**
  - Left border: red when not ordered, green when ordered, amber with a tint when late. Background `#F1F4FA` when ticked.
  - Checkbox, item, "short N", parties with SO dates.
  - Not ordered: **Mark ordered** button.
  - Ordered: green "Ordered 6 Oct · expected 10 Oct" (red "— late" when late), plus **Change date** and **Undo** links.
  - Sort inside a group: not-ordered first, then by name.
- [ ] **When will it arrive?** (`WhenChoices`): **2 / 4 / 7 days**, or **Pick a date** → `<input type=date min=today>` + **Next**, plus a **Cancel** link. The server allows today up to 180 days ahead.

### Every action → one Confirm modal (`Confirm`, `:294`)
- [ ] **Look**
  - Backdrop `rgba(12,17,27,.6)`; clicking it cancels, except while saving.
  - Modal up to 600 px, 6 px navy top border.
  - Name 28 px, one line, optional bullet list (first 12 + "… and N more"), error line.
  - **CANCEL** (outline) left / **CONFIRM** right, 48 px gap (32 px on phone), each up to 220 px; 52 px tall buttons.
- [ ] **While saving:** every action button on the page is disabled; CONFIRM shows a 16 px spinner and "SAVING…".
- [ ] **Danger** confirms are red. A **double** confirm (bulk clear) needs a second tap: "TAP AGAIN TO CLEAR N ORDERS" with a red glow ring `.jo-btn-armed`.
- [ ] **Run engine** (`run`, `:108`):
  - Optimistic local change first.
  - Success: `mergeStable` with the server's `overview`, ok message, confirm closes.
  - Failure: rollback, and "Not saved — …" shown inside the confirm.
- [ ] **Actions**

  | Action | Line | Confirm label | API call | Optimistic change | Ok message |
  |---|---|---|---|---|---|
  | Clear (one line, "all short" or "all pending") | "Clear N pending items for X? Busy's sales order does not change." + list | CLEAR (red) | `{op:'clear', orderId, lineNos}` | `O.clearLines` | "X: N pending items cleared. [Nothing else was pending, so the order is closed.] They are under “Export cleared lines” on the logs page." |
  | Pick anyway | "Send X (SO 754) back to NEW now…" | PICK ANYWAY | `{op:'pick_anyway', orderId}` | `O.pickAnyway` | "…is back in NEW — the tablet shows "Pick anyway"." |
  | Wait for material | as the tablet, + list of short items | WAIT FOR MATERIAL | `{op:'wait', orderId}` (event `source:'owner'`) | `O.waitForMaterial` | "X (SO 754) is waiting for material." |
  | Mark ordered / Change date | "Mark ITEM as ordered, arriving Fri 10 Oct?" / "Change the expected date of ITEM to …?" | MARK ORDERED / CHANGE DATE | `{op:'ordered', id, days or date}` | `O.markOrdered` | "ITEM: ordered, expected 10 Oct. [Now fully ordered: A, B.]" |
  | Undo | "Mark ITEM as NOT ordered again (undo)?" | UNDO | `{op:'unordered', id}` | `O.unmarkOrdered` | "ITEM: back to not ordered." |
  | Bulk MARK N ORDERED | Bulk bar button → modal "Mark N items ordered" with WhenChoices (backdrop click closes) → confirm with list | MARK N ORDERED | `{op:'ordered_many', ids, days or date}` | `O.markOrdered` | "N items marked ordered, expected 10 Oct. [k had left the list.]" — then all ticks cleared |
  | Bulk CLEAR ALL PENDING | "Clear all pending on N orders — L lines in all?" + list | CLEAR N ORDERS (red, double) | `{op:'clear_many', orders:[{orderId, lineNos}]}` | `O.clearMany` | lines, orders, closed and failed counts — then ticks cleared |

  - Bulk clear uses `clearableLines`: amber orders clear only their short lines.
- [ ] **Bulk bar** (`.jo-bulkbar`):
  - Fixed at the bottom; white, 3 px gold top border, shadow `0 -6px 20px`.
  - Shows when anything is ticked on the active tab: "N items/orders ticked", **Untick all** link, and the big action button.
  - On a phone the button goes full width, with safe-area padding.

### Daily email card ("Daily email at 17:30", `DailyEmail`, `:480`)
- [ ] `GET /api/cron/daily-email?preview=1` → `{subject, html, ready, reason, to, lastRuns}`.
- [ ] Text: "Goes to a, b every day around 17:30." or "Not set up yet: {reason}. Nothing is sent until then." Then "**Subject today:** …".
- [ ] **Preview today’s email** / **Hide preview** → `<iframe srcDoc>`, 520 px tall.
- [ ] **Send it now** → Confirm ("Send today's email now to …?", SEND NOW) → `POST /api/cron/daily-email`. Results: "Sent …" / "Not sent: …" / error. Reloads after.
- [ ] Last 5 runs: IST time · Sent / Failed / Not sent — detail.

---

## Page: Logs (`/logs`, `src/pages/Logs.jsx`, `src/logs.css`)

- [ ] **Access:** admin PIN session (same as /admin). Header "Logs", links "Owner ›", "Admin ›", "Signed in as", Sign out. Frame max width 1440.
- [ ] **Tabs** **Order log** / **Staff summary**: underline style, gold 3 px when active. Switching tabs does not reload.
- [ ] **Filters:**
  - FROM / TO date inputs. Default is the last 7 days in IST (`istDay(-6)` to today), each limited by the other (`min`/`max`).
  - STAFF select ("Everyone" + every person seen so far; the list grows as you filter, it is never reduced).
  - CUSTOMER text ("All customers"; contains match, server side).
  - STAFF and CUSTOMER show only on the Order log tab, **but are still applied** on the Staff summary tab.
  - Any filter change reloads after a **250 ms debounce** (`:55`) and resets to page 1.
  - Call: `GET /api/admin/logs?from&to[&staff][&customer]`. The server limits the range to one year and leaves out orders closed as `invoiced_before_tracking`, `deleted_in_busy`, `cancelled_in_busy`, `closed_at_go_live` or `closed_by_admin`.
- [ ] **Totals:** "N orders · ₹value" (Order log tab).
- [ ] **Export to Excel** (outline style on the Staff tab) / "Preparing…":
  - Loads `xlsx` (SheetJS CDN tarball) only when clicked, via dynamic import.
  - Workbook with sheets **Order log** (26 columns, including Pick to dispatch, Labels, LR photo, Cleared lines, Entered waiting via, Stage) and **Staff summary**.
  - File name `JCM-Orders-logs_{from}_to_{to}.xlsx`.
- [ ] **Export cleared lines:**
  - `GET /api/admin/logs?cleared=1&from&to` (range by clearing date) → sheet "Cleared lines" → file `JCM-Orders-cleared-lines_…xlsx`.
  - When there are none: error "No lines were cleared between 5 Oct and 10 Oct."
- [ ] **Order log table:** 14 columns, horizontal scroll, minimum width 1340 px, **row hover `#FBF8F1`**.
  - CUSTOMER (+ city · SO date)
  - SO NO. ("SO 754")
  - INVOICE (short form, full value as tooltip)
  - PICKED BY
  - CHECKED BY (+ time)
  - DISPATCHED BY (+ time + **LR photo** link)
  - UNASSIGNED / PICKING / CHECKING / READY: durations, **red when over the stage limit**
  - BOXES (+ "labels skipped")
  - VALUE (₹)
  - PENDING (amber "N lines" + "k cleared")
  - WAITING VIA ("Partial invoice" / "Button · who" / "All lines short (system)")
  - 12 rows per page. Footer: "Showing x of y · …", "‹ Previous / Page n of m / Next ›" (disabled links greyed). Empty: "No orders in this range."
- [ ] **LR photo viewer:**
  - Overlay `rgba(12,17,27,.7)`; click outside closes.
  - Box up to 900 px: "LR photo · Name", **Open full size** (new tab), **Close**.
  - Image up to `100vh − 120px`. Shows Loading / error.
  - Call: `GET /api/admin/logs?photo=<order id>` → a 10-minute signed URL.
- [ ] **Staff summary:**
  - Left card "Orders per person": bars with 22 px track, coloured by role (Picker `#2E7D5B`, Supervisor `#2F5FA3`, Dispatch `#12213B`), legend Picking / Checking / Dispatch.
  - Right table: PERSON (+ role) / ORDERS / INVOICE VALUE / AVG TIME / TOTAL TIME / BOXES / TOP CATEGORY.
  - Footer note about own-stage times.
  - Under 900 px the two parts stack.
- [ ] **Logic** (`api/_lib/logs.js buildLogs`): stage times come from the first `order_events` of each type. PICKING ends at `payload.invoiced_at`.

---

## API (Vercel functions, `vercel.json` region `hnd1` Tokyo)

**Function count = 10** (files outside `api/_lib`): `tablet.js`, `board.js`, `health.js`, `admin/devices.js`, `admin/hindi.js`, `admin/login.js`, `admin/logs.js`, `admin/owner.js`, `admin/settings.js`, `cron/daily-email.js`.
- `_lib/` files do not count (underscore prefix).
- The Hobby plan allows 12. All tablet calls are deliberately in one function.
- Every handler except `health` and `daily-email` is wrapped in `withTiming`: a `Server-Timing` header plus a `[time] …` log line when `VERCEL` is set.

| Endpoint | Auth | Ops |
|---|---|---|
| `GET /api/health` | none | `{ok, app, time}` |
| `/api/tablet` | device; staff Bearer except roster, login, ping | GET `op=ping` (no auth), `op=roster`, `op=orders`, `op=order&id`, `op=label_job&id`, `op=material`. POST `login`, `logout`, `pick`, `check`, `ready{boxes, labels}`, `dispatch{photo?}`, `wait`, `print_labels{id, reprint, boxNumbers?}`, `material_ordered{id, days or date}`, `material_unordered{id}` |
| `GET /api/board` | device (`?ping=1` no auth) | board payload |
| `POST /api/admin/login` | none | `{pin}` → `{token, name, expiresAt}` |
| `/api/admin/devices` | admin | GET list; POST `{name, kind}` → `{token, device}`; PATCH `{id, active}` |
| `/api/admin/settings` | admin | GET `{thresholds, people, tabletStaff}`; POST `{thresholds}` / `{tabletStaff}` / `{closeOld:{days, confirm}}` |
| `/api/admin/hindi` | admin | GET `{language, ready, rows, missing}`; POST `language` / `save` / `accept` / `generate` (40 at a time, 5 in parallel) |
| `/api/admin/owner` | admin (`?ping=1` no auth) | GET overview / `?order=` detail; POST `ordered`, `ordered_many` (≤300), `unordered`, `clear`, `clear_many` (≤200, 5 in parallel), `pick_anyway`, `wait`. Every POST returns `{overview}` |
| `/api/admin/logs` | admin | GET `?from&to[&staff][&customer]`, `?photo=`, `?cleared=1&from&to` |
| `/api/cron/daily-email` | `Bearer CRON_SECRET` (cron) or admin | cron GET = send; admin GET `?preview=1`; admin POST = send now |

**Rules worth keeping:**
- **Conditional moves.** `update … eq('stage', from)`. A double tap gets 409 "already been moved on by someone else". If the move fails after a photo was saved, the photo is removed.
- **Moves and their events:**
  - pick → `picker_id`, event `pick`
  - check → `checker_id`, event `checked`
  - ready → `boxes`, event `in_bay {boxes, labels:'print'|'skipped'}`; PRINT also queues a label job
  - dispatch → `dispatcher_id`, event `dispatched {lr_photo}`, then WhatsApp
- **Jobs are enforced on the server** (`api/_lib/staff.js` `can` / `stagesFor`). An order outside your stages gets 403.
- **WhatsApp** (`api/_lib/whatsapp.js`): AiSensy v2, 8 template values, 8 s timeout. It never blocks a dispatch. Every outcome is recorded as event `whatsapp_sent`.
- **Label queue** (`api/_lib/labeljobs.js`): inserts `label_print_jobs`, with Hindi from `party_hindi` and Google transliteration (4 s timeout). It falls back when the phase 8 / 10 columns are missing. `slow` = queued for more than 30 s.
- **`selectTolerant`** (`api/_lib/columns.js`): if a newer column is missing, the read retries with the older column list, so the live board survives an SQL script that has not been run yet.

---

## Database (Supabase CRM project `cmtnzmfuasniicsdxyle`; RLS on, no policies, service key only)

| Table / object | Created by | Notes |
|---|---|---|
| `profiles` (CRM, existing) | CRM | read: id, name, email, role, is_admin, active. Phase 2 adds unused `pin_hash`, `hide_from_roster` |
| `user_pins` (CRM, existing) | CRM | read only; `user_id`, `pin` (plain text) |
| `devices` | phase2-orders-schema.sql | id, name, kind tv/tablet, token_hash, active, created_at, last_seen_at |
| `staff_sessions` | phase2 | profile_id, device_id, token_hash, expires_at |
| `orders` | phase2; +grown_at/grown_reason/expected_set_* phase6; +waiting_since/via/by phase9 | id `<fiscal_db>:<SO no>`, so_*, party_* (name/city/address/mobile/gstin), line_count, order_value, stage (new/picking/invoiced/checked/in_bay/dispatched/waiting), stage_since, picker/checker/dispatcher_id, invoice_* (+invoice_vch_nos[]), boxes, expected_date (retired), hidden_until (ignored), needs_partial_notice (retired), closed_at, closed_reason |
| `order_lines` | phase2; +line_value phase5; +cleared_at/by/qty phase8 | pending_qty is a generated column; item_group, supplier_name |
| `order_events` | phase2; event check widened in phase8/9 | events: new, pick, invoiced, checked, in_bay, dispatched, partial, expected_set, grown, whatsapp_sent, label_printed, closed, lines_cleared, material_ordered, waiting; profile_id, device_id, payload, at |
| `procurement` | phase2; +expected_date phase8 | one open row per item; ordered_at/by, closed_at, so_refs[], for_parties[] |
| `stock_cache` | phase2 | item_code, qty, refreshed_at (written by the sync) |
| `orders_config` | phase2 (+threshold row, repeated in phase3) | keys: `threshold_minutes`, `tablet_staff`, `label_language` `{language}`, `tv_display` (no UI yet) |
| `orders_sync_log` | phase2 | run_at, status success/error, counts, details |
| `admin_sessions`, `orders_login_attempts` | phase3-board.sql | |
| `orders_email_log` | phase6-waiting-material.sql | sent_at, recipient, status sent/not_sent/failed, detail |
| `label_print_jobs` | phase8-material-clear-labels.sql; +party_name_hi/party_city_hi/language/box_numbers[] phase10 | status queued/printing/printed/failed, error, claimed_at, finished_at |
| `party_hindi` | phase10-label-hindi.sql | english_key primary key, kind, english, hindi, source google/manual, needs_review, updated_by |
| Storage bucket `lr-photos` (private) | storage-lr-photos.sql (the code also creates it if missing) | path `SO-754/2026-10-06_143012.jpg`; 7-day signed link for WhatsApp, 10-min link for logs |
| Trigger fn `jcm_orders_touch_updated_at` | phase2 | on orders, order_lines, procurement, party_hindi |

One-off scripts (not schema):
- `cleanup-go-live-1-dry-run.sql`, `cleanup-go-live-2-close.sql` (cut-off 2026-10-04).
- `check-so-763.sql` (read only).

Never create a table named `sync_log`. That name belongs to the other project, `jlkjjqnmhsgefpluemyz`.

---

## Env vars

**Vercel (web app):**
- `ORDERS_SUPABASE_URL`, `ORDERS_SUPABASE_SERVICE_KEY`: required. If missing, the API answers 503 "The server is not set up yet."
- `CRON_SECRET`: lets the daily cron call send. Without it, scheduled runs are refused.
- `RESEND_API_KEY`, `ORDERS_REPORT_EMAIL` (comma/space list), `ORDERS_EMAIL_FROM` (default `JCM Orders <onboarding@resend.dev>`): the daily email.
- `AISENSY_API_KEY`, `AISENSY_DISPATCH_CAMPAIGN` (plain template), `AISENSY_DISPATCH_PHOTO_CAMPAIGN` (image template), `ORDERS_WHATSAPP_LIVE=true`: WhatsApp actually sends only with key + campaign + live.
- `VERCEL`: set by the platform; turns on the `[time]` log lines.

**Cron** (`vercel.json`): `/api/cron/daily-email` at `0 12 * * *` (17:30 IST; on Hobby it may fire within the hour).

**JCM-Server `.env`** (`D:\JCM-Supabase\files`, shared with the CRM's sync.js):
- `ORDERS_SUPABASE_URL`, `ORDERS_SUPABASE_SERVICE_KEY` (not `SUPABASE_URL`).
- `BUSY_SERVER` (host[,port]), `BUSY_DATABASE` (also the `fiscal_db`), `BUSY_USER`, `BUSY_PASSWORD`.
- `ORDERS_SO_VCH_TYPE` (required, 12), `ORDERS_SO_SERIES` (default 261), `ORDERS_SALE_VCH_TYPE` (default 9), `ORDERS_GODOWN` (default 201).
- `ORDERS_LOOKBACK_DAYS` (14), `ORDERS_START_DATE`, `ORDERS_GO_LIVE_DATE` (2026-10-04), `ORDERS_SUPPLIER_FIELD`.
- `ORDERS_SITE_URL` (default https://orders.jcmretails.com), `ORDERS_KEEP_WARM` ("false" turns it off).
- `PRINTER_IP` (required for the agent), `PRINTER_PORT` (9100), `PRINTER_DIRECTION` (1/0), `PRINTER_GAP_MM` (3), `PRINTER_SHIFT_DOTS`, `PRINTER_BITMAP_INVERT=1`.

---

## Server scripts (JCM-Server)

- [ ] **`sync-orders.js`**
  - Runs every 3 min from Task Scheduler (`run-sync-orders.bat`). Has `--dry-run`. Logs to `sync-orders.log`.
  - Reads Busy MSSQL:
    - `Tran1` (SO VchType 12, series 261, and invoices)
    - `Tran2` (RecType 4 lines)
    - `Tran3` (RecType 4 invoice links)
    - `Master1` (items, groups, parties), `MasterAddressInfo` (Station = city), `BillingDet` (names / mobiles)
    - `DailySum` (stock D1, godown 201)
  - Writes (all conditional on the from-stage, so tablet taps win):
    - `orders`, `order_lines`, `order_events` (new / invoiced / partial / waiting / grown / closed)
    - `stock_cache`, `procurement`
    - `orders_sync_log` (one row per run, success or error)
  - Rules:
    - Go-live skip. NEVER_REOPEN = invoiced_before_tracking, closed_at_go_live, closed_by_admin.
    - Parks NEW orders with every line short as `all_short`.
    - Waiting / dispatched orders return to NEW with reason `stock` or `date`.
    - Closes dispatched / waiting orders with nothing left (`complete`), Busy-cancelled orders and Busy-deleted orders. Mass deletion is guarded (Busy returning 0 rows while more than 3 are open closes nothing).
    - Fixes the INVOICED timer to the invoice moment.
  - **Depends on the web app:**
    - Same table and column names, and `orders_config`.
    - Cleared lines (`cleared_qty`) and procurement `ordered_at` / `expected_date` set by /owner and the tablet.
    - After every run it pings keep-warm `/api/tablet?op=ping`, `/api/admin/owner?ping=1`, `/api/board?ping=1`. **A re-host must keep these ping endpoints, or change `WARM_PATHS` (`sync-orders.js:991`).**
- [ ] **`print-agent.js`**
  - Started at boot by Task Scheduler task "JCM Orders print agent" via `run-print-agent.bat` (restarts 10 s after any exit). Logs to `print-agent.log`.
  - Polls `label_print_jobs` every 5 s, 10 jobs at a time:
    - Marks jobs stuck in `printing` for over 2 min as failed ("The print agent stopped while printing. Tap REPRINT.").
    - Claims each job (`queued` → `printing`, conditional), so a job is never printed twice.
    - Sends TSPL over raw TCP to `PRINTER_IP:9100` (20 s timeout).
    - Marks `printed` / `failed` with a plain reason (connection refused / no answer / bad IP).
    - Inserts the `label_printed` event `{boxes, box_numbers, reprint, job_id, printer, hindi}`.
  - **The label:**
    - 4×6 in at 203 dpi = 812×1218 dots, drawn as one 1-bit picture with `@napi-rs/canvas` (Roboto Condensed + Noto Sans Devanagari from `busy-sync/fonts`) and sent with TSPL `BITMAP`.
    - Top strip: SO NO. | INVOICE (JCM/ stripped) | PRINT DATE.
    - Party block: name in capitals (70 → 56 px, wraps), Hindi name 18 dots below the ink above, address (commas tidied, city appended), Hindi city, "Mob. 98260 11745 / …", GSTIN. The whole block shrinks (scale 0.9 → 0.5) if it would crowd the box number.
    - A 6-dot rule, then spaced "B O X", a big number and "of N".
    - Falls back to the printer's built-in fonts (ASCII only) when the canvas library is missing.
    - English only when `job.language = 'en'`.
  - Commands: `--test` (prints the long sample, box 12 of 15), `--png <folder>`, `--show`.
  - **Depends on the web app** filling `label_print_jobs` (including `language`, `party_name_hi`, `party_city_hi`, `box_numbers`) and on the tablet polling `op=label_job`.
- [ ] **`update-server.bat` / `update-server.ps1`**
  - git pull in `D:\JCM-Orders-repo`, then copies `busy-sync/*.js`, `*.bat` and `fonts\` into `D:\JCM-Supabase\files`.
  - Installs only missing packages from `server-packages.txt` (mssql, dotenv, @supabase/supabase-js, @napi-rs/canvas).
  - Restarts the print agent if its files changed. The script must stay plain ASCII.
- [ ] `busy-discover.js`: a one-off Busy schema explorer.

---

## Gaps and differences between the notes and the code (check these during the rebuild)

1. **Tablet MARK ORDERED is not optimistic.** `CLAUDE.md` says it is; the code isn't. `markItemOrdered` and `addDays` in `tablet-logic.js` are unused.
2. **No Undo or date picker on the tablet** material screen. The server has `material_unordered`, but no button uses it.
3. **The tablet confirm text for "Change date"** still says "Mark X as ordered, arriving in N days?".
4. **/owner idle gate is 20 s**, not 60 s as `CLAUDE.md` implies. The interval itself is 60 s.
5. **Admin "TV display" tab** from the v2 design is not built. `tv_display` can only be set in the DB or the dev server.
6. **Logs keeps the STAFF and CUSTOMER filters** while on the Staff summary tab, even though those fields are hidden there.
7. **Leftover CSS with no markup:** `.tb-mat-tick*`, `.tb-home-title`, `.tb-sheet-green`, `.tb-sheet-title-lg`, `.jo-partial*`, `.jo-wait*`, `.jo-tick*`, `.jo-mat-row`, `.jo-mat-amber`.
8. **Dev and test helpers you may want to port:** `test/dev-server.mjs` routes `/__as-tv`, `/__as-admin`, `/__empty`, `/__seed`, `/__tv-display`, `/__print-agent`, `/__adblock?page=`. Admin PIN 4321. Test files: `test/*.mjs`.

Files: `/home/claude/jcm-orders/src/App.jsx`, `src/pages/{Tablet,Board,Admin,Owner,Logs}.jsx`, `src/lib/{api,storage,useFit,photo,board-logic,tablet-logic,owner-logic}.js`, `src/{styles,tablet,board,admin,logs}.css`, `api/{tablet,board,health}.js`, `api/admin/*.js`, `api/cron/daily-email.js`, `api/_lib/*.js`, `supabase/*.sql`, `vercel.json`, `index.html`, `busy-sync/{sync-orders,print-agent}.js`, `busy-sync/{run-print-agent,run-sync-orders,update-server}.bat`, `busy-sync/update-server.ps1`, `busy-sync/server-packages.txt`, `CLAUDE.md`.