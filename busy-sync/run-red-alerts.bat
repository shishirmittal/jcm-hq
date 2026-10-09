@echo off
REM Wrapper for Windows Task Scheduler, same shape as run-stock-live.bat.
REM cd /d so the script finds its own .env, node_modules and log file no
REM matter what working directory the Scheduler hands it.
cd /d "%~dp0"
node sync-red-alerts.js
exit /b %ERRORLEVEL%
