@echo off
pushd "%~dp0"
if not exist "node_modules\vite\package.json" call npm ci --no-audit --no-fund
if errorlevel 1 goto finish
call npm run build:ui
if errorlevel 1 goto finish
node preview.cjs --open
:finish
if errorlevel 1 pause
popd
