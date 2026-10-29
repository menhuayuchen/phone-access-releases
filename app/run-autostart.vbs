' Runs the phone-access autostart completely hidden (no console window).
' Used as the scheduled task action so the 2-minute watchdog never flashes a window.
' 改动（与 P0-2 同类：消灭绝对路径）：原来这一行把 autostart.ps1 的路径写死成 C:\Users\ccj\Documents\...，
' 换台机器/换用户名后，计划任务每 2 分钟跑一次、每次都失败，只在日志里留一行 —— 整套自愈层静默死掉。
' 现在改成用本文件所在目录推导：app 目录整体拷到哪里都能跑，不需要改这里。
Dim sh, cmd, fso, here, q
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)
cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " & q & here & "\autostart.ps1" & q
sh.Run cmd, 0, False
