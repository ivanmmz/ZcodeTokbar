@echo off
rem ===================================================================
rem  ZCode token bar - installer
rem  Detects node / ZCode / pythonw, writes paths.ini, patches the
rem  SessionStart hook, repoints the ZCode Start Menu shortcut and
rem  creates the desktop shortcut. Safe to re-run.
rem ===================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo  ZCode token bar - install
echo  -------------------------
echo.

set "NODE="
set "ZCODE="
set "PYW="

rem ---- node ----
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE set "NODE=%%I"
if not defined NODE (
  for %%P in ("%ProgramFiles%\nodejs\node.exe" "%ProgramFiles(x86)%\nodejs\node.exe" "%LOCALAPPDATA%\Programs\nodejs\node.exe") do (
    if not defined NODE if exist "%%~P" set "NODE=%%~P"
  )
)
if not defined NODE (
  echo  [!] node.exe not found. Install Node.js first, then re-run install.cmd.
  pause
  exit /b 1
)
echo  node   : %NODE%

rem ---- ZCode ----
for %%P in (
  "%LOCALAPPDATA%\Programs\ZCode\ZCode.exe"
  "%ProgramFiles%\ZCode\ZCode.exe"
  "%ProgramFiles(x86)%\ZCode\ZCode.exe"
) do (
  if not defined ZCODE if exist "%%~P" set "ZCODE=%%~P"
)
if not defined ZCODE set /p "ZCODE=  ZCode.exe full path: "
if not exist "%ZCODE%" (
  echo  [!] ZCode.exe not found at "%ZCODE%".
  pause
  exit /b 1
)
echo  zcode  : %ZCODE%

rem ---- pythonw (optional; floating fallback only) ----
for %%D in (Python313 Python312 Python311) do (
  if not defined PYW if exist "%LOCALAPPDATA%\Programs\Python\%%D\pythonw.exe" set "PYW=%LOCALAPPDATA%\Programs\Python\%%D\pythonw.exe"
)
if not defined PYW (
  for /f "delims=" %%I in ('where pythonw 2^>nul') do if not defined PYW set "PYW=%%I"
)
if defined PYW (echo  pythonw: %PYW%) else (echo  pythonw: not found - floating fallback off, in-page mode still works)

rem ---- write paths.ini ----
> "paths.ini" echo node=%NODE%
>> "paths.ini" echo zcode=%ZCODE%
if defined PYW >> "paths.ini" echo pythonw=%PYW%
echo.
echo  paths.ini written.

rem ---- SessionStart hook ----
"%NODE%" "%~dp0setup.js" add
if errorlevel 1 echo  [!] hook setup failed - run setup.js manually.

rem ---- shortcuts ----
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0shortcuts.ps1"
if errorlevel 1 echo  [!] shortcut setup failed - see the message above.

echo.
echo  Done. Launch ZCode from the Start Menu; the counter appears
echo  under the input box about two seconds after the window opens.
echo.
pause
