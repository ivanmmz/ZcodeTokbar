# Create / repoint the shortcuts used by the token bar.
#   -StartMenu : repoint the ZCode Start Menu shortcut at launch_zcode.vbs
#   -Restore   : copy ZCode.lnk.backup back over the Start Menu shortcut
param([switch]$StartMenu, [switch]$Restore)

$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ws = New-Object -ComObject WScript.Shell
$menu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\ZCode.lnk"
$backup = Join-Path $dir "ZCode.lnk.backup"

if ($Restore) {
  if (Test-Path $backup) {
    Copy-Item $backup $menu -Force
    Write-Host "  Start Menu shortcut restored from backup."
  } else {
    Write-Host "  [i] no ZCode.lnk.backup - shortcut left as is."
  }
  $desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) "Token Counter.lnk"
  if (Test-Path $desktopLnk) { Remove-Item $desktopLnk -Force; Write-Host "  Desktop shortcut removed." }
  exit 0
}

# ---- read paths.ini ----
$cfg = @{}
foreach ($k in 'node', 'zcode', 'pythonw') { $cfg[$k] = "" }
$ini = Join-Path $dir "paths.ini"
if (Test-Path $ini) {
  foreach ($line in Get-Content $ini) {
    $i = $line.IndexOf('=')
    if ($i -gt 0) {
      $key = $line.Substring(0, $i).Trim().ToLower()
      if ($cfg.ContainsKey($key)) { $cfg[$key] = $line.Substring($i + 1).Trim() }
    }
  }
}
if (-not $cfg['node']) { $cfg['node'] = "node.exe" }

# ---- Start Menu shortcut ----
if (-not $Restore -and (Test-Path $menu)) {
  # Back up the current shortcut whenever it is not already ours, so that a
  # copy shipped from another machine is never mistaken for the real original.
  $cur = $ws.CreateShortcut($menu)
  $alreadyOurs = ($cur.Arguments -like "*launch_zcode.vbs*")
  if (-not $alreadyOurs) { Copy-Item $menu $backup -Force }
  $l = $ws.CreateShortcut($menu)
  $l.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
  $l.Arguments = '"' + (Join-Path $dir "launch_zcode.vbs") + '"'
  $l.WorkingDirectory = $dir
  if ($cfg['zcode']) { $l.IconLocation = $cfg['zcode'] + ",0" }
  $l.Save()
  Write-Host "  Start Menu shortcut repointed (original saved as ZCode.lnk.backup)."
} elseif (-not (Test-Path $menu)) {
  Write-Host "  [i] no ZCode shortcut in Start Menu - skipped."
}

# ---- desktop shortcut ----
$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) "Token Counter.lnk"
$d = $ws.CreateShortcut($desktopLnk)
$d.TargetPath = $cfg['node']
$d.Arguments = '"' + (Join-Path $dir "token_bar_cdp.js") + '"'
$d.WorkingDirectory = $dir
$d.Description = "ZCode token counter"
if ($cfg['zcode']) { $d.IconLocation = $cfg['zcode'] + ",0" }
$d.Save()
Write-Host "  Desktop shortcut created."
