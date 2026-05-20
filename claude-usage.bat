@echo off
REM Claude Usage Dashboard - Windows launcher.
REM Double-click this file to start the dashboard.

title Claude Usage Dashboard
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Claude Usage Dashboard
  echo   ----------------------
  echo   Node.js is not installed.
  echo   Get it from https://nodejs.org ^(you need version 22.5 or newer^),
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%i in ('node -p "process.versions.node.split('.').map(Number)[0]*1000 + process.versions.node.split('.').map(Number)[1]"') do set NODE_VER=%%i
if %NODE_VER% LSS 22005 (
  echo.
  echo   Claude Usage Dashboard needs Node.js 22.5 or newer.
  for /f "tokens=*" %%v in ('node -v') do echo   You have: %%v
  echo   Update from https://nodejs.org
  echo.
  pause
  exit /b 1
)

node server.js
if errorlevel 1 pause
