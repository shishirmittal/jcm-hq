// Single nav definition shared by the desktop sidebar and mobile drawer
// (sidebar.js) — do not fork this into two trees. hash values match what
// main.js's route() actually dispatches on today, not the spec's
// illustrative example (in particular, Control Centre's hash is genuinely
// '#dashboard' — a pre-existing naming collision with the home route's own
// hash of '' — left as-is since renaming it means touching main.js's
// routing, out of scope for this pass).
//
// adminOnly no longer gates visibility on its own. Who sees what is decided
// by permissions.js from profiles.allowed_tabs, which lets an admin grant one
// sensitive tab to one person without making them a full admin. The flag
// stays because Manage Users still marks those tabs as "normally admin only"
// when an admin is ticking boxes — it is a warning now, not a rule.
//
// Items a user may not see are filtered OUT of the array entirely, never
// hidden with CSS — see visibleNav() in permissions.js.
//
// grantable: false marks a tab that cannot be handed out per-user at all,
// as distinct from adminOnly's "sensitive, but tickable". Manage Users is
// the only one: its gate is the service-role admin check inside
// /api/admin-users, which a ticked box here could never satisfy, so the box
// is rendered disabled rather than offering something that cannot work.
//
// badge keys are looked up against the counts object sidebar.js fetches
// (loadNavBadges) and omitted entirely when the count is 0 or missing.
// JCM HQ grouping (Phase A, 2026-10-10). Page ids are unchanged from the
// CRM on purpose: profiles.allowed_tabs stores them, so every person keeps
// exactly the pages they had. Collections and Warehouse sections arrive with
// their pages in later phases.
//
// open: true — shown to everyone signed in, never gated by allowed_tabs.
// Stock has always been reachable by every user (main.js routes #stock before
// any permission check); it simply had no row in the web sidebar until now.
export const NAV_CONFIG = [
  { section: 'Main', items: [
    { id: 'dashboard', label: 'Dashboard', icon: 'grid', hash: '' },
    { id: 'tasks', label: 'Task Board', icon: 'clipboard', hash: '#tasks', badge: 'openTasks' },
    // Questions from Red Alerts about entries this person made in Busy.
    // open: everyone signed in can see it; the API only returns their own.
    { id: 'explain', label: 'My Explanations', icon: 'question', hash: '#explain', open: true, badge: 'myExplain' },
  ] },
  { section: 'CRM', items: [
    { id: 'leads', label: 'Project Leads', icon: 'flag', hash: '#leads', badge: 'openLeads' },
    { id: 'architects', label: 'Architects', icon: 'compass', hash: '#architects' },
    { id: 'electricians', label: 'Electricians', icon: 'bolt', hash: '#electricians' },
  ] },
  { section: 'Sales', items: [
    // One customer on one screen (phone tab): contact, dues + ageing, bills,
    // ledger, orders, follow-ups. api/customers.js: admins or 'customers' ticked.
    { id: 'customers', label: 'Customer Card', icon: 'idcard', hash: '#customers' },
    { id: 'quotations', label: 'Quotations', icon: 'file', hash: '#quotations', badge: 'pendingQuotes' },
    { id: 'payments', label: 'Payments', icon: 'rupee', hash: '#payments', adminOnly: true },
  ] },
  // Payment Follow-up: call/WhatsApp parties with dues by account group, save
  // outcomes + next follow-up date. api/collections.js lets in admins and anyone
  // with 'payment-followup' in allowed_tabs. Badge = follow-ups due today/overdue.
  { section: 'Collections', items: [
    { id: 'payment-followup', label: 'Payment Follow-up', icon: 'phone', hash: '#payment-followup', adminOnly: true, badge: 'paymentFollowup' },
  ] },
  // JCM Orders admin screens (from orders.jcmretails.com /owner and /logs).
  // adminOnly as on the orders site, but grantable: tick one for a person in
  // Manage Users and api/orders.js lets them in too.
  { section: 'Warehouse', items: [
    // The staff tablet's work (pick, check, boxes + labels, dispatch with LR
    // photo) for people signed in to HQ — a phone tab. Jobs come from Warehouse
    // & Devices → Tablet staff; api/orders.js?h=floor enforces them.
    { id: 'floor-orders', label: 'Orders', icon: 'pick', hash: '#floor-orders' },
    { id: 'material', label: 'Pending Material', icon: 'package', hash: '#material' },
    { id: 'order-log', label: 'Order Log', icon: 'clock', hash: '#order-log', adminOnly: true },
  ] },
  { section: 'Purchase & Stock', items: [
    { id: 'orders', label: 'Order Planning', icon: 'truck', hash: '#order-planning' },
    { id: 'stock', label: 'Stock', icon: 'warehouse', hash: '#stock', open: true },
    // grantable: false — the gate that actually matters is the "Admins can
    // update catalog" RLS policy on catalog_items, which a ticked box here
    // could never satisfy.
    { id: 'price-update', label: 'Price Update', icon: 'tag', hash: '#price-update', adminOnly: true, grantable: false },
    { id: 'items-management', label: 'Items Management', icon: 'layers', hash: '#items-management', adminOnly: true },
  ] },
  { section: 'Insights', items: [
    { id: 'control', label: 'Control Centre', icon: 'chart', hash: '#dashboard', adminOnly: true },
    // ₹0 sales lines and deletions in Busy, fed by busy-sync/sync-red-alerts.js.
    // Grantable like Payments: api/red-alerts.js lets in admins and anyone with
    // 'red-alerts' in allowed_tabs. Badge = alerts still New + answers waiting.
    { id: 'red-alerts', label: 'Red Alerts', icon: 'alert-triangle', hash: '#red-alerts', adminOnly: true, badge: 'redAlerts' },
  ] },
  { section: 'Admin', items: [
    { id: 'users', label: 'Manage Users', icon: 'users', hash: '#admin', adminOnly: true, grantable: false },
    { id: 'warehouse', label: 'Warehouse & Devices', icon: 'monitor', hash: '#warehouse', adminOnly: true },
  ] },
]
