@echo off
REM Wrapper for Windows Task Scheduler (task "JCM Dues"), same shape as run-red-alerts.bat.
REM dues-env.js loads .env and hands BUSY_PASSWORD to sync-dues-final.js as BUSY_SQL_PASSWORD.
cd /d "%~dp0"
node -r ./dues-env.js sync-dues-final.js
exit /b %ERRORLEVEL%
