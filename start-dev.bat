@echo off
setlocal

set "NEXUS_ROOT=%~dp0"
set "NODE=C:\nvm4w\nodejs\node.exe"
set "NPM_PATH=C:\Users\kruz7\AppData\Roaming\npm"
set "CARGO_PATH=C:\Users\kruz7\.cargo\bin"
set "PATH=%NPM_PATH%;%CARGO_PATH%;%PATH%"

echo Starting Nexus server...
start "" /B "%NODE%" "%NEXUS_ROOT%packages\server\dist\index.js"

timeout /t 2 /nobreak >nul

echo Starting Nexus desktop app...
start "Nexus Dev" cmd /k "cd /d "%NEXUS_ROOT%" && pnpm tauri:dev"

echo Done. The app window will appear in ~30s once Rust compiles.
