@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Please install Node.js 20 or newer first.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

echo Building app...
call npm run build
if errorlevel 1 (
  pause
  exit /b 1
)

echo Starting Cherry Canvas Pro...
echo Open http://127.0.0.1:5174/ in your browser.
call npm start
pause
