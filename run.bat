@echo off
title Slovenian Sea Level Tracker Launcher
echo Starting the local web server and CORS proxy...

:: Launch PowerShell server in a new window so the user can see request logs and terminate it easily by closing the window
start "Slovenian Sea Level Tracker Server" powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0server.ps1"

:: Wait 2 seconds for the server to initialize and bind the port
timeout /t 2 > nul

echo Opening browser...
start http://localhost:8082/

echo Launcher finished. Close this window.
exit
