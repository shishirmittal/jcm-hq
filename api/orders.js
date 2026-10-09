import owner from './_orders/handlers/owner.js'
import logs from './_orders/handlers/logs.js'
import devices from './_orders/handlers/devices.js'
import settings from './_orders/handlers/settings.js'
import hindi from './_orders/handlers/hindi.js'
import email from './_orders/handlers/email.js'
import board from './_orders/handlers/board.js'
import floor from './_orders/handlers/floor.js'

// One Vercel function for every JCM Orders admin screen inside JCM HQ — the
// Hobby plan allows 12 functions in a project, so the orders handlers share
// this one instead of taking six. Each handler is the jcm-orders code as it
// was (api/_orders/handlers, api/_orders/lib); only sign-in changed: HQ pages
// send the person's HQ (Supabase) token, and the page's tab id below decides
// who besides admins may use it (Manage Users → allowed_tabs).
//
//   /api/orders?h=owner     Pending Material      (was /api/admin/owner)
//   /api/orders?h=email     17:30 email preview / send now (was /api/cron/daily-email — the
//                           scheduled run itself stays on orders.jcmretails.com)
//   /api/orders?h=logs      Order Log             (was /api/admin/logs)
//   /api/orders?h=devices   screens list, switch off/on (was /api/admin/devices)
//   /api/orders?h=settings  time limits, tablet staff, TV display, close old orders
//   /api/orders?h=hindi     carton label language and Hindi names
//   /api/orders?h=board     the TV board's data, for the TV display preview
//   /api/orders?h=floor     the Orders tab: pick / check / ready / dispatch (was /api/tablet)
const ROUTES = {
  owner: [owner, 'material'],
  email: [email, 'material'],
  logs: [logs, 'order-log'],
  devices: [devices, 'warehouse'],
  settings: [settings, 'warehouse'],
  hindi: [hindi, 'warehouse'],
  board: [board, 'warehouse'],
  floor: [floor, 'floor-orders'],
}

export default async function handler(req, res) {
  const h = new URL(req.url || '/', 'http://x').searchParams.get('h') || ''
  const route = ROUTES[h]
  if (!route) {
    res.setHeader('Cache-Control', 'no-store')
    res.status(404).json({ error: 'Unknown request.' })
    return
  }
  req.hqTab = route[1]
  return route[0](req, res)
}
