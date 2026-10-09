@echo off
REM Wrapper for Windows Task Scheduler, matching run-sync.bat's shape.
REM cd /d so the script finds its own .env, node_modules and log file no
REM matter what working directory the Scheduler hands it.
cd /d "%~dp0"
node sync-stock-live.js
exit /b %ERRORLEVEL%
