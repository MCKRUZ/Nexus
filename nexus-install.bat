@echo off
REM ──────────────────────────────────────────────────────────────
REM  nexus-install.bat — Quick-install Nexus Desktop from last build
REM  Creates desktop shortcut + Start Menu entry.
REM ──────────────────────────────────────────────────────────────

setlocal

set "INSTALLER=%~dp0packages\dashboard\src-tauri\target\release\bundle\nsis\Nexus_0.1.0_x64-setup.exe"

if not exist "%INSTALLER%" (
    echo [nexus-install] No installer found. Run nexus-build.bat first.
    echo   Expected: %INSTALLER%
    pause
    exit /b 1
)

echo [nexus-install] Launching Nexus installer...
echo   %INSTALLER%
echo.
start "" "%INSTALLER%"

endlocal
