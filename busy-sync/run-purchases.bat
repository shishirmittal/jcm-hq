@echo off
REM Wrapper for Windows Task Scheduler, same shape as run-red-alerts.bat.
REM cd /d so the script finds its own .env, node_modules and log file.
cd /d "%~dp0"
node sync-purchases.js
exit /b %ERRORLEVEL%
