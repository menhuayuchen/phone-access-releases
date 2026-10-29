Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W3 {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    public static string FgTitle() { var sb = new StringBuilder(256); GetWindowText(GetForegroundWindow(), sb, 256); return sb.ToString(); }
}
'@
function Inject($events) {
  $json = @{ events = $events } | ConvertTo-Json -Compress -Depth 5
  $tmp = Join-Path $env:TEMP 'inject.json'
  [IO.File]::WriteAllText($tmp, $json, [Text.Encoding]::ASCII)
  curl.exe -s --max-time 6 -X POST -H 'content-type: application/json' --data-binary "@$tmp" 'http://100.108.92.22:8660/input' | Out-Null
}
$altTab = @(@{ t = 'key'; vk = 18; down = 1 }, @{ t = 'key'; vk = 9; down = 1 },
            @{ t = 'key'; vk = 9; down = 0 }, @{ t = 'key'; vk = 18; down = 0 })

# 切到 SSID（管理员权限窗口）
for ($i = 1; $i -le 8; $i++) {
  if ([W3]::FgTitle() -like '*SSID*') { break }
  Inject $altTab; Start-Sleep -Milliseconds 800
}
$fg = [W3]::FgTitle()
"前台=『$fg』"

# 在"前台是管理员窗口"的情况下注入：移动 + 点击
Inject @(@{ t = 'move'; x = 1180; y = 690 })
Start-Sleep -Milliseconds 400
$c1 = (curl.exe -s --max-time 5 'http://100.108.92.22:8660/cursor')
"注入 move(1180,690) 后 cursor=$c1"

Inject @(@{ t = 'down'; b = 1 }, @{ t = 'up'; b = 1 })
Start-Sleep -Milliseconds 500
$c2 = (curl.exe -s --max-time 5 'http://100.108.92.22:8660/cursor')
"注入 click 后 cursor=$c2"

Start-Sleep -Milliseconds 600
"前台(注入后)=『$([W3]::FgTitle())』"
