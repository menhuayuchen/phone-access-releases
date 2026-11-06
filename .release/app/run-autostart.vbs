' Runs the PhoneAccess autostart completely hidden (no console window).
' Used as the scheduled task action so the 2-minute watchdog never flashes a window.
' Paths are derived from this file's own folder, so the app directory can be copied
' anywhere: no hard-coded absolute path and no per-machine edits.
Dim sh, cmd, fso, here, q
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)
cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " & q & here & "\autostart.ps1" & q
sh.Run cmd, 0, False
