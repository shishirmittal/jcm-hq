// Preloaded by run-dues.bat:  node -r ./dues-env.js sync-dues-final.js
//
// sync-dues-final.js (the party_dues sync that feeds HQ's Payment Follow-up)
// is older than the other scripts: it reads BUSY_SQL_USER / BUSY_SQL_PASSWORD
// from the environment and never opens .env. This loads the same .env that
// sync.js and sync-red-alerts.js use and copies BUSY_USER / BUSY_PASSWORD
// across, so the password lives in one place and the script stays unchanged.
require('dotenv').config();
if (!process.env.BUSY_SQL_PASSWORD && process.env.BUSY_PASSWORD) process.env.BUSY_SQL_PASSWORD = process.env.BUSY_PASSWORD;
if (!process.env.BUSY_SQL_USER && process.env.BUSY_USER) process.env.BUSY_SQL_USER = process.env.BUSY_USER;
