@echo off
rem Start the token bar controller (reads node path from paths.ini when present)
setlocal
set "NODE=node"
if exist "%~dp0paths.ini" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0paths.ini") do (
    if /i "%%A"=="node" set "NODE=%%B"
  )
)
start "" "%NODE%" "%~dp0token_bar_cdp.js"
endlocal
