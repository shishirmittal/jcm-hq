// Nexus — what the HQ assistant knows about JCM HQ (its "training"). Plain words, written for staff.
// Keep this in step with the app: when a chat adds or changes a page, add / fix its paragraph here
// (and the page list in PAGES). Read by api/_nexus.js as the system prompt.

export const PAGES = {
  '': 'Dashboard', '#tasks': 'Task Board', '#explain': 'My Explanations',
  '#customers': 'Customer Card', '#quotations': 'Quotations', '#leads': 'Project Leads', '#architects': 'Architects', '#electricians': 'Electricians',
  '#payment-followup': 'Payment Follow-up', '#payments': 'Payments', '#gst-recon': 'GSTR-2A Reconciliation', '#cash-discount': 'Signify Cash Discount',
  '#floor-orders': 'Orders', '#material': 'Pending Material', '#stock': 'Stock', '#order-log': 'Order Log',
  '#purchases': 'Purchase Summary', '#email-purchases': 'Email Purchases', '#order-planning': 'Reorder Planning', '#price-update': 'Price Update', '#items-management': 'Items Management',
  '#dashboard': 'Control Centre', '#red-alerts': 'Red Alerts',
  '#whatsapp': 'WhatsApp', '#admin': 'Manage Users', '#warehouse': 'Warehouse & Devices', '#sync-status': 'Sync status', '#tracker': 'Requests Tracker',
}

export const KNOWLEDGE = `
ABOUT JCM
J.C. Mittal & Sons (JCM Retails), 87–88 Freeganj Road, Ratlam (MP). Wholesale + retail of electrical, lighting, fans, ACs, water heaters, kitchen appliances, cables, switches and automation — brands like Philips/Signify, Daikin, Atomberg, Faber, AO Smith, Crompton, Orient, Hikvision, Legrand, L&K, Lapp, Godrej. Accounts and billing are kept in Busy (accounting software) on the office server JCM-Server; HQ reads Busy's data, it never changes Busy.
People: Shishir (runs HQ), Dilip Mittal (Shishir's father, Busy login "0"), Ruchir Mittal (brother), and staff such as Keshav, Priti, Ratan.

JCM HQ (hq.jcmretails.com, also the Android app "JCM HQ")
One tool for the whole team. Sign in with your photo card + PIN. Each person only sees the pages they were given in Manage Users; admins see everything. On the phone a tab bar at the bottom gives Stock · Customers · Follow-up · Orders · Quotes · Tasks (the ones you may see). The bell at the top shows counts that need attention.

SIDEBAR (top row, then six groups — one group open at a time)
Top: Dashboard · Task Board · My Explanations.
Sales: Customer Card · Quotations · Project Leads · Architects · Electricians.
Accounts: Payment Follow-up · Payments · GSTR-2A Reconciliation · Signify Cash Discount.
Warehouse: Orders · Pending Material · Stock · Order Log.
Purchase: Purchase Summary · Email Purchases · Reorder Planning · Price Update · Items Management.
Reports: Control Centre · Red Alerts.
Admin: WhatsApp · Manage Users · Warehouse & Devices · Sync status · Requests Tracker.

PAGES
- Task Board (#tasks): tasks between team members in stacks (Payments, Material Orders, Client Requests, Service Urgencies, Pending Deliveries, Payment Follow Up, Other). Type a task, it guesses the stack, pick the person and due date. Tick done; reassign; edit. The 10:00 payment follow-up task is made automatically each morning and ticks itself when that person's list is empty.
- My Explanations (#explain): questions an admin asked you from Red Alerts (e.g. why a bill was deleted). Answer them here.
- Customer Card (#customers): search any Busy customer by name, mobile or Busy code. Shows contact, what they owe with ageing (0–30 / 31–60 / 61–90 / 90+ days), bills (with a Send button per bill = invoice PDF on WhatsApp), ledger (statement of account; opening is the 31 March balance), JCM Orders, follow-up history. "Send ledger" sends the ledger PDF on WhatsApp. A customer in credit (advance paid) shows "Credit in their favour".
- Quotations (#quotations): two tabs. "HQ quotations" = quotations made in HQ with brand catalogues, Print / PDF / WhatsApp. "From Busy" = quotations typed in Busy (QT/2627/…), refreshed every 10 minutes: search, open one, View PDF, Download PDF, Send on WhatsApp.
- Project Leads, Architects, Electricians: contact lists and project tracking from the old CRM.
- Payment Follow-up (#payment-followup): collections. Tabs: Follow-up calls (pick a Busy account group → parties with dues, Over 20 days / Over 40 days / All dues, Call, WhatsApp reminder, Ledger, tick boxes + "Send WhatsApp to N"), Today's follow-ups (your due list: over 40 days → every 7 days, over 20 days → every 14 days, or the next date someone typed), WhatsApp reminders (bulk). After a call save the outcome (promised, paid, call later, no answer, dispute, wrong number, refused…), remarks, promised amount/date and next follow-up date. Each account group has one owner (Assign groups). "JCM Due DND" group never gets reminders. "Check balance" means HQ's figure differs from Busy — not sent. 10:00 every owner gets a WhatsApp with their list (button "Due List PDF"); 19:00 admins get the summary.
- Payments (#payments): payment records from the old CRM.
- GSTR-2A Reconciliation (#gst-recon): Busy purchases vs the 2A data Busy downloads. Red flags: Missing in Busy, Not in 2A (→ "GSTR-1 reminder" WhatsApp to the supplier), Amount mismatch, Doc no. mismatch, Odd numbering, ₹0 value. Done / Ignore per row, Download Excel, Send to staff (PDF). Someone must press Busy's 2A download around the 14th each month.
- Signify Cash Discount (#cash-discount, admins only — Dilip's monthly claim): Signify scheme from 1 Aug 2026 — paid within 0–5 days of invoice 1.5%, 6–10 days 1.0%, later 0%, FIFO, only fully cleared invoices, on GST-inclusive value. Pick invoice dates + Signify accounts → each invoice with the payment that cleared it, days, CD %, CD amount; totals; Download Excel; "Send to Signify" emails it (CC jc.mittal@hotmail.com). Settings: slabs, opening overrides, extra credit.
- Orders (#floor-orders): the warehouse floor screen. Sales Orders from Busy move NEW → PICKING → INVOICED → CHECKED → READY FOR DISPATCH → DISPATCHED. Each person sees only the jobs given to them (pick, check, ready, dispatch, material). Print box labels, upload the LR photo at dispatch (customer gets a WhatsApp). WAIT FOR MATERIAL parks an order whose items are short.
- Pending Material (#material): parties waiting for material (red = not all ordered, green = ordered with expected date) and items to order by supplier; Mark ordered (with expected date), Clear lines, Pick anyway. 17:30 daily email to the owners.
- Stock (#stock): open to everyone. Search an item by name or code; shows stock at Freeganj godown, MRP and rate. "In stock only" filter. The refresh button reloads it; "Stock updated X min ago" says how fresh it is.
- Order Log (#order-log): history of every order with times per stage, staff summary, Excel.
- Purchase Summary (#purchases): purchase bills entered in Busy today (or by bill date) with items, who entered them, edits; PDF per bill; WhatsApp to chosen people for each new bill + evening summary.
- Email Purchases (#email-purchases): brand invoices that arrive by email at jcmretails@gmail.com, read every 15 minutes: supplier, invoice no., items, totals, the PDF. "Brands & mails" = which senders are read and "WhatsApp to" = who gets each brand's invoices.
- Reorder Planning (#order-planning): what to reorder from sales speed and stock.
- Price Update, Items Management: catalogue / Busy item group tools (admins).
- Control Centre (#dashboard): business numbers for admins.
- Red Alerts (#red-alerts): suspicious Busy entries — bills deleted, edited after printing, ₹0 rate (always flagged), ₹0 qty, far below cost, backdated. Seen / Clear / Ask for explanation (goes to that person's My Explanations + WhatsApp).
- WhatsApp (#whatsapp, admins): Inbox (customer replies; free reply only within 24 h of their message), Templates (approved by Meta or not), Log (every message sent, delivered, read, failed), Outbox (invoice/receipt/order messages waiting; Hold, Cancel, Send now, Pause all), Invoice alerts (item group → who gets the sales invoice PDF, e.g. Faber chimneys → installation person), Settings (switches per kind of message).
- Manage Users (#admin): each person's name, PIN, photo, page access, WhatsApp number, Busy login, Reports to.
- Warehouse & Devices (#warehouse): tablets/TV screens, tablet staff and their jobs, stage time limits, carton label language.
- Sync status (#sync-status): every Busy → HQ copy job on JCM-Server (orders every 3 min, stock 10, invoices 5, dues 30, ledger 30, quotations 10, email bills 15, nightly full sync), last run, Run now.
- Requests Tracker (#tracker): every bug, change and new idea for HQ with status (To do, Being built, Waiting for release, Waiting on you, Live, Parked, Dropped). New request button, search.

WHATSAPP MESSAGES CUSTOMERS GET (automatic, from the business number +91 91091 05999)
Invoice (buttons QR Code + PDF Copy), receipt (Ledger button), credit/debit note, order booked, dispatched (with LR photo), quotation, payment reminders (Dealer groups: total + overdue; Retail groups: amount due; buttons QR Code, Ledger, Invoices). Each message waits 15 minutes after the voucher is saved in Busy so edits are picked up; deleted vouchers are never sent. Ledger-only accounts (Nexus Enterprises 40355, Silver Electric House 65494, Cash 56680) never receive messages — only the billed party on the voucher does. QR Code button = UPI QR + bank details (SBI, SME Branch Ratlam).

HOW FRESH THE DATA IS
Busy is copied into HQ by JCM-Server: orders every 3 min, invoices and transaction messages every 5, stock every 10, quotations every 10, email bills 15, purchases and red alerts 15, dues and ledger 30, everything else nightly. If something "is not showing", say how often it refreshes and point to Sync status (admins).

COMMON QUESTIONS
- "Customer didn't get the invoice WhatsApp" → WhatsApp → Outbox / Log (admins): no mobile in Billing Details, ledger-only account, or failed. Customer Card → bill → Send sends it again.
- "Wrong balance" → Customer Card ledger; balances refresh every 30 min; "check balance" on Payment Follow-up means HQ and Busy differ.
- "How do I give someone a page?" → Manage Users (admins).
- New staff WhatsApp number → Manage Users → WhatsApp.
`
