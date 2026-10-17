@echo off
rem ===================================================================
rem  Recommended entry point: deploy the token bar to a LOCAL folder
rem  and install it there.
rem
rem  Why local: running the controller straight out of a cloud-synced
rem  folder can be disturbed by sync (file locks, dehydrating files).
rem  This copies scripts\ to %USERPROFILE%\.zcode\tools\token-bar and
rem  runs install.cmd there. Re-run any time to update.
rem ===================================================================
setlocal
set "DEST=%USERPROFILE%\.zcode\tools\token-bar"

echo.
echo  ZCode token bar - deploy to local folder
echo  ----------------------------------------
echo  Source : %~dp0
echo  Target : %DEST%
echo.

if not exist "%DEST%" mkdir "%DEST%"

copy /y "%~dp0token_bar_cdp.js" "%DEST%\" >nul
copy /y "%~dp0token_bar.py"     "%DEST%\" >nul
copy /y "%~dp0launch_zcode.vbs" "%DEST%\" >nul
copy /y "%~dp0ensure-shortcut.vbs" "%DEST%\" >nul
copy /y "%~dp0setup.js"         "%DEST%\" >nul
copy /y "%~dp0shortcuts.ps1"    "%DEST%\" >nul
copy /y "%~dp0install.cmd"      "%DEST%\" >nul
copy /y "%~dp0uninstall.cmd"    "%DEST%\" >nul
copy /y "%~dp0start.cmd"        "%DEST%\" >nul
copy /y "%~dp0stop.cmd"         "%DEST%\" >nul
copy /y "%~dp0deploy-local.cmd" "%DEST%\" >nul

rem keep the pristine Start Menu shortcut backup with the installation
if exist "%~dp0ZCode.lnk.backup" if not exist "%DEST%\ZCode.lnk.backup" copy /y "%~dp0ZCode.lnk.backup" "%DEST%\" >nul

echo  Files copied. Running installer...
echo.

call "%DEST%\install.cmd"
