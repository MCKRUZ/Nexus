@echo off
REM ──────────────────────────────────────────────────────────────
REM  nexus-build.bat — Production build for Nexus Desktop
REM  Builds all packages, compiles server sidecar, bundles Tauri.
REM ──────────────────────────────────────────────────────────────

setlocal

REM Ensure cargo + npm are on PATH
set "PATH=%USERPROFILE%\.cargo\bin;%APPDATA%\npm;%PATH%"

cd /d "%~dp0"

echo [nexus-build] Step 1/3: Building all packages...
call pnpm build
if %ERRORLEVEL% neq 0 (
    echo [nexus-build] ERROR: pnpm build failed
    exit /b 1
)

echo [nexus-build] Step 2/3: Compiling server sidecar (esbuild + pkg)...
call pnpm --filter @nexus/server compile
if %ERRORLEVEL% neq 0 (
    echo [nexus-build] ERROR: server compile failed
    exit /b 1
)

echo [nexus-build] Step 3/3: Building Tauri release bundle...
call pnpm tauri:build
if %ERRORLEVEL% neq 0 (
    echo [nexus-build] ERROR: Tauri build failed
    exit /b 1
)

echo.
echo ============================================================
echo  BUILD COMPLETE
echo  Output: packages\dashboard\src-tauri\target\release\bundle\
echo ============================================================

endlocal
