@echo off
REM Wrapper for Windows Task Scheduler, same shape as run-red-alerts.bat.
cd /d "%~dp0"
node sync-ledger.js
exit /b %ERRORLEVEL%
