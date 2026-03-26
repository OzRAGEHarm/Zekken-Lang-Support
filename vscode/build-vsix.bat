@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Error: Node.js is required to build the VSIX.
  exit /b 1
)

if not exist dist mkdir dist

for /f "usebackq delims=" %%i in (`node -p "require('./package.json').name"`) do set EXT_NAME=%%i
for /f "usebackq delims=" %%i in (`node -p "require('./package.json').version"`) do set EXT_VERSION=%%i

set OUT_FILE=dist\%EXT_NAME%-%EXT_VERSION%.vsix

echo [VSIX] Packaging extension...
echo [VSIX] Output: %OUT_FILE%

call npx --yes @vscode/vsce package --out "%OUT_FILE%"
if errorlevel 1 exit /b 1

echo [VSIX] Done.

