@echo off
REM ──────────────────────────────────────────────────────────────
REM  nexus-build.bat — Production build for Nexus Desktop
REM  Builds all packages, compiles server sidecar, bundles Tauri.
REM ──────────────────────────────────────────────────────────────

setlocal enabledelayedexpansion

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
echo.

set "INSTALLER=%~dp0packages\dashboard\src-tauri\target\release\bundle\nsis\Nexus_0.1.0_x64-setup.exe"
if exist "%INSTALLER%" (
    echo  Installer: %INSTALLER%
    echo.
    set /p INSTALL="  Run installer now? [Y/n] "
    if /i "!INSTALL!" neq "n" (
        echo  Launching installer...
        start "" "%INSTALLER%"
    )
) else (
    echo  WARNING: NSIS installer not found at expected path.
    echo  Check: packages\dashboard\src-tauri\target\release\bundle\nsis\
)

endlocal
