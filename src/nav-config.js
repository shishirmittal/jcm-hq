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
  // Sidebar layout agreed with Shishir 2026-10-15: daily pages on top (no
  // heading), then six groups. Ids never change — they are the permission ids in
  // profiles.allowed_tabs — only labels, order and groups do. `bare` = no heading.
  { section: 'Main', bare: true, items: [
    { id: 'dashboard', label: 'Dashboard', icon: 'grid', hash: '' },
    // Staff page (2026-10-16): only the day's follow-up list. Anyone with the full Payment Follow-up page sees it too
    // (alias). The full page (calls, reminders, scheduled) lives in Admin.
    { id: 'followup-today', label: "Today's Follow-ups", icon: 'phone', hash: '#followups', badge: 'paymentFollowup', alias: 'payment-followup' },
    { id: 'tasks', label: 'Task Board', icon: 'clipboard', hash: '#tasks', badge: 'openTasks' },
    { id: 'explain', label: 'My Explanations', icon: 'question', hash: '#explain', open: true, badge: 'myExplain' },
  ] },
  { section: 'Sales', items: [
    { id: 'customers', label: 'Customer Card', icon: 'idcard', hash: '#customers' },
    { id: 'quotations', label: 'Quotations', icon: 'file', hash: '#quotations', badge: 'pendingQuotes' },
    { id: 'leads', label: 'Project Leads', icon: 'flag', hash: '#leads', badge: 'openLeads' },
    { id: 'architects', label: 'Architects', icon: 'compass', hash: '#architects' },
    { id: 'electricians', label: 'Electricians', icon: 'bolt', hash: '#electricians' },
  ] },
  { section: 'Accounts', items: [
    { id: 'payments', label: 'Payments', icon: 'rupee', hash: '#payments', adminOnly: true },
    { id: 'gst-recon', label: 'GSTR-2A Reconciliation', icon: 'percent', hash: '#gst-recon', adminOnly: true },
    { id: 'cash-discount', label: 'Signify Cash Discount', icon: 'percent', hash: '#cash-discount', adminOnly: true, grantable: false },
  ] },
  { section: 'Warehouse', items: [
    { id: 'floor-orders', label: 'Orders', icon: 'pick', hash: '#floor-orders' },
    { id: 'material', label: 'Pending Material', icon: 'package', hash: '#material' },
    { id: 'stock', label: 'Stock', icon: 'warehouse', hash: '#stock', open: true },
    { id: 'order-log', label: 'Order Log', icon: 'clock', hash: '#order-log', adminOnly: true },
  ] },
  { section: 'Purchase', items: [
    { id: 'purchases', label: 'Purchase Summary', icon: 'receipt', hash: '#purchases', adminOnly: true, badge: 'purchasesToday' },
    { id: 'email-purchases', label: 'Email Purchases', icon: 'mail', hash: '#email-purchases', adminOnly: true, badge: 'emailBillsToday' },
    { id: 'orders', label: 'Reorder Planning', icon: 'truck', hash: '#order-planning' },
    { id: 'price-update', label: 'Price Update', icon: 'tag', hash: '#price-update', adminOnly: true, grantable: false },
    { id: 'items-management', label: 'Items Management', icon: 'layers', hash: '#items-management', adminOnly: true },
  ] },
  { section: 'Reports', items: [
    { id: 'control', label: 'Control Centre', icon: 'chart', hash: '#dashboard', adminOnly: true },
    { id: 'red-alerts', label: 'Red Alerts', icon: 'alert-triangle', hash: '#red-alerts', adminOnly: true, badge: 'redAlerts' },
  ] },
  { section: 'Admin', items: [
    { id: 'payment-followup', label: 'Payment Follow-up', icon: 'phone', hash: '#payment-followup', adminOnly: true },
    { id: 'whatsapp', label: 'WhatsApp', icon: 'message', hash: '#whatsapp', adminOnly: true, badge: 'waUnread' },
    { id: 'users', label: 'Manage Users', icon: 'users', hash: '#admin', adminOnly: true, grantable: false },
    { id: 'warehouse', label: 'Warehouse & Devices', icon: 'monitor', hash: '#warehouse', adminOnly: true },
    { id: 'sync-status', label: 'Sync status', icon: 'history', hash: '#sync-status', adminOnly: true },
    { id: 'tracker', label: 'Requests Tracker', icon: 'check', hash: '#tracker', adminOnly: true },
  ] },
]
