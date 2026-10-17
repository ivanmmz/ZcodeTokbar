@echo off
rem Undo install.cmd: stop the controller, restore the ZCode shortcut, drop the hook.
setlocal
cd /d "%~dp0"

echo.
echo  ZCode token bar - uninstall
echo.

call "%~dp0stop.cmd"

rem ---- restore shortcuts / remove desktop shortcut ----
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0shortcuts.ps1" -Restore

rem ---- drop the SessionStart hook ----
set "NODE="
if exist "paths.ini" (
  for /f "usebackq tokens=1,* delims==" %%A in ("paths.ini") do (
    if /i "%%A"=="node" set "NODE=%%B"
  )
)
if not defined NODE for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE set "NODE=%%I"
if defined NODE (
  "%NODE%" "%~dp0setup.js" remove
) else (
  echo  [i] node not found - remove the SessionStart hook manually from:
  echo      %%USERPROFILE%%\.zcode\cli\config.json
)

echo.
echo  Uninstalled. Backups kept: ZCode.lnk.backup, config.json.token-bar.bak
echo.
pause
