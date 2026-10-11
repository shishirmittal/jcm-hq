@echo off
REM JCM Sync: runs every Busy -> Supabase job (see jcm-sync.js). Task Scheduler
REM starts this once, at startup. If JCM Sync ever stops, it starts again after 15 seconds.
cd /d "%~dp0"
:again
node jcm-sync.js
ping -n 16 127.0.0.1 > nul
goto again
