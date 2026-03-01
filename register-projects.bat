@echo off
setlocal enabledelayedexpansion

set NEXUS=node "C:\Users\kruz7\OneDrive\Documents\Code Repos\MCKRUZ\Nexus\packages\cli\dist\index.js"
set REPOS=C:\Users\kruz7\OneDrive\Documents\Code Repos\MCKRUZ

echo Registering all MCKRUZ projects with Nexus...
echo.

for /d %%D in ("%REPOS%\*") do (
    set "NAME=%%~nD"
    if /I not "!NAME!"=="Nexus" (
        echo Adding: !NAME!
        %NEXUS% project add "%%D" 2>&1
        echo.
    )
)

echo Done! Run 'nexus project list' to verify.
