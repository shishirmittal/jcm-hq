# followup-notify.js — Payment Follow-up daily messages

Run by **JCM Sync** every 15 minutes (job `followup-notify` in `jcm-sync.js`). It only calls
`https://hq.jcmretails.com/api/collections` with `{ action: 'daily-run' }` and the Busy service key
from `.env` (`SUPABASE_SERVICE_KEY`). HQ decides what to send:

- **After 10:00** (collection_settings.morning_at), once a day: for every person who has follow-ups due
  (their account groups, set in Payment Follow-up → Today's follow-ups → Assign groups):
  one Task Board task (card "Payment Follow Up", ticks itself done when their list is empty) and one
  WhatsApp (Meta template `staff_followup_morning`, number = Manage Users → WhatsApp) with the count, total and the biggest three; a button opens Today's follow-ups in HQ.
- **After 19:00** (evening_at), once a day: a summary WhatsApp to every admin — per person done / left,
  promises made, no answers, promises due today.
- If the PC was off at 10:00, the morning run happens at the next run that day (before 19:00).

Admins can also press "Send today's lists now" / "Send evening summary now" on the Today tab.

Install: copy `followup-notify.js` and the updated `jcm-sync.js` into `D:\JCM-Supabase\files`, then
restart JCM Sync (or the PC). Log: `followup-notify.log` in the same folder.
