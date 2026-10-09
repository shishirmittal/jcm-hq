import { sendDispatchWhatsApp } from './whatsapp.js'

// Everything that follows a DISPATCHED tap, after the order has moved.
// Returns extra facts for the tablet; the WhatsApp part never throws.
// An order that leaves with lines still pending stays 'dispatched' (open): the
// TV board and /owner show it as waiting for material from its pending lines,
// and the sync brings it back to NEW when the stock arrives or on the expected date.
export async function afterDispatch(dbc, orderId, me, device, opts = {}) {
  const whatsapp = await sendDispatchWhatsApp(dbc, orderId, me, device, opts)
  return { whatsapp: whatsapp.status }
}
