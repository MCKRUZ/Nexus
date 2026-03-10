@echo off
REM ──────────────────────────────────────────────────────────────
REM  nexus-dev.bat — One-command dev launcher for Nexus Desktop
REM  Starts the Node server + Tauri dev (Vite + Rust) together.
REM ──────────────────────────────────────────────────────────────

setlocal

REM Ensure cargo + npm are on PATH
set "PATH=%USERPROFILE%\.cargo\bin;%APPDATA%\npm;%PATH%"

cd /d "%~dp0"

echo [nexus-dev] Building core + server packages...
call pnpm --filter @nexus/core build
if %ERRORLEVEL% neq 0 (
    echo [nexus-dev] ERROR: core build failed
    exit /b 1
)
call pnpm --filter @nexus/server build
if %ERRORLEVEL% neq 0 (
    echo [nexus-dev] ERROR: server build failed
    exit /b 1
)

echo [nexus-dev] Starting Node server on :47340...
start /b "nexus-server" node packages/server/dist/index.js

REM Give server a moment to bind
timeout /t 2 /nobreak >nul

echo [nexus-dev] Starting Tauri dev (Vite + Rust)...
call pnpm tauri:dev

echo [nexus-dev] Shutting down server...
taskkill /fi "WINDOWTITLE eq nexus-server" /f >nul 2>&1
REM Also kill any node process on port 47340
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :47340 ^| findstr LISTENING') do (
    taskkill /pid %%a /f >nul 2>&1
)

echo [nexus-dev] Done.
endlocal
