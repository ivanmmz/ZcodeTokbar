' Make sure the ZCode Start Menu shortcut still launches through launch_zcode.vbs.
' ZCode's updater rewrites that shortcut back to a plain ZCode.exe launch, which
' silently costs us the Chromium debug port - without it the in-page token counter
' cannot attach at all.
' Idempotent: does nothing when the shortcut is already ours. Run it directly, or
' let the Startup shortcut call it. No console window (run with wscript).
Option Explicit

Dim fso, sh, scriptDir, vbs, menu, lnk, zcode, ts, line, pos, key, val, log

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
vbs = scriptDir & "\launch_zcode.vbs"
If Not fso.FileExists(vbs) Then WScript.Quit 0

menu = sh.SpecialFolders("StartMenu") & "\Programs\ZCode.lnk"
If Not fso.FileExists(menu) Then WScript.Quit 0

Set lnk = sh.CreateShortcut(menu)
If InStr(1, lnk.Arguments, "launch_zcode.vbs", vbTextCompare) > 0 Then WScript.Quit 0 ' already ours

' ZCode.exe for the icon
zcode = ""
If fso.FileExists(scriptDir & "\paths.ini") Then
  Set ts = fso.OpenTextFile(scriptDir & "\paths.ini", 1)
  Do Until ts.AtEndOfStream
    line = Trim(ts.ReadLine)
    pos = InStr(line, "=")
    If pos > 0 Then
      key = LCase(Trim(Left(line, pos - 1)))
      val = Trim(Mid(line, pos + 1))
      If key = "zcode" And val <> "" Then zcode = val
    End If
  Loop
  ts.Close
End If

Set log = fso.OpenTextFile(scriptDir & "\shortcut-heal.log", 8, True)
log.WriteLine Now & "  ZCode.lnk was reset to: " & lnk.TargetPath & " " & lnk.Arguments & "  -> repairing"
log.Close

lnk.TargetPath = sh.ExpandEnvironmentStrings("%WINDIR%") & "\System32\wscript.exe"
lnk.Arguments = """" & vbs & """"
lnk.WorkingDirectory = scriptDir
If zcode <> "" Then lnk.IconLocation = zcode & ",0"
lnk.Save
