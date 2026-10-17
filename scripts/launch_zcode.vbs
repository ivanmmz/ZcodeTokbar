' Launch ZCode with the Chromium debug port and start the token bar controller.
' Self-locating: reads node/zcode paths from paths.ini in the same folder.
' Called by the ZCode Start Menu shortcut. No console window.
Option Explicit

Dim fso, sh, scriptDir, ts, line, pos, key, val
Dim nodeExe, zcodeExe, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = "node.exe"
zcodeExe = ""

If fso.FileExists(scriptDir & "\paths.ini") Then
  Set ts = fso.OpenTextFile(scriptDir & "\paths.ini", 1)
  Do Until ts.AtEndOfStream
    line = Trim(ts.ReadLine)
    pos = InStr(line, "=")
    If pos > 0 Then
      key = LCase(Trim(Left(line, pos - 1)))
      val = Trim(Mid(line, pos + 1))
      If key = "node" And val <> "" Then nodeExe = val
      If key = "zcode" And val <> "" Then zcodeExe = val
    End If
  Loop
  ts.Close
End If

If zcodeExe = "" Then
  MsgBox "paths.ini is missing the 'zcode' entry. Run install.cmd again.", 16, "ZCode token bar"
  WScript.Quit 1
End If

' 1) start the controller first; it waits in the background for the debug port
cmd = """" & nodeExe & """ """ & scriptDir & "\token_bar_cdp.js"""
sh.Run cmd, 0, False

' 2) then launch ZCode with the debug port enabled
' Port can be overridden with the ZCTB_CDP_PORT environment variable (default 9333),
' which must match the controller's ZCTB_CDP_PORT.
Dim dbgPort
dbgPort = sh.ExpandEnvironmentStrings("%ZCTB_CDP_PORT%")
If dbgPort = "%ZCTB_CDP_PORT%" Or Trim(dbgPort) = "" Then dbgPort = "9333"
cmd = """" & zcodeExe & """ --remote-debugging-port=" & Trim(dbgPort)
sh.Run cmd, 1, False
