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
  ] },
  { section: 'CRM', items: [
    { id: 'leads', label: 'Project Leads', icon: 'briefcase', hash: '#leads', badge: 'openLeads' },
    { id: 'architects', label: 'Architects', icon: 'building', hash: '#architects' },
    { id: 'electricians', label: 'Electricians', icon: 'bolt', hash: '#electricians' },
  ] },
  { section: 'Sales', items: [
    { id: 'quotations', label: 'Quotations', icon: 'file', hash: '#quotations', badge: 'pendingQuotes' },
    { id: 'payments', label: 'Payments', icon: 'card', hash: '#payments', adminOnly: true },
  ] },
  { section: 'Purchase & Stock', items: [
    { id: 'orders', label: 'Order Planning', icon: 'truck', hash: '#order-planning' },
    { id: 'stock', label: 'Stock', icon: 'box', hash: '#stock', open: true },
    // grantable: false — the gate that actually matters is the "Admins can
    // update catalog" RLS policy on catalog_items, which a ticked box here
    // could never satisfy.
    { id: 'price-update', label: 'Price Update', icon: 'pencil', hash: '#price-update', adminOnly: true, grantable: false },
    { id: 'items-management', label: 'Items Management', icon: 'layers', hash: '#items-management', adminOnly: true },
  ] },
  { section: 'Insights', items: [
    { id: 'control', label: 'Control Centre', icon: 'chart', hash: '#dashboard', adminOnly: true },
  ] },
  { section: 'Admin', items: [
    { id: 'users', label: 'Manage Users', icon: 'users', hash: '#admin', adminOnly: true, grantable: false },
  ] },
]
