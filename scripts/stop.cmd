@echo off
rem Stop the token bar controller and any floating fallback window
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*token_bar_cdp*' } | Stop-Process -Force" 2>nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe'\" | Where-Object { $_.CommandLine -like '*token_bar*' } | Stop-Process -Force" 2>nul
echo Token bar stopped.
