@echo off
REM Double-click this to start the printer bridge.
REM Change --target console to your printer once you have tested it, e.g.
REM   node server.js --target 192.168.1.50
REM   node server.js --target COM3

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node is not installed on this computer.
  echo Get it from https://nodejs.org, then run this again.
  echo.
  pause
  exit /b 1
)

node server.js --target console

REM keeps the window open if the bridge stops or fails, so the reason is readable
echo.
pause
