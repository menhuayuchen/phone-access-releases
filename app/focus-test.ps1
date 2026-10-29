Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W2 {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    public static string FgTitle() { var sb = new StringBuilder(256); GetWindowText(GetForegroundWindow(), sb, 256); return sb.ToString(); }
    public static string Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return r.L + "," + r.T + "," + r.R + "," + r.B; }
}
'@

function Inject($events) {
  $json = @{ events = $events } | ConvertTo-Json -Compress -Depth 5
  $tmp = Join-Path $env:TEMP 'inject.json'
  [IO.File]::WriteAllText($tmp, $json, [Text.Encoding]::ASCII)
  curl.exe -s --max-time 6 -X POST -H 'content-type: application/json' --data-binary "@$tmp" 'http://100.108.92.22:8660/input' | Out-Null
}

$target = '任务管理器'
$hwnd = [IntPtr]([int64]::Parse('110594', 'Hex'))
$rect = [W2]::Rect($hwnd)
"目标窗口 rect=$rect  ($([W2]::Rect($hwnd)))"

for ($i = 1; $i -le 12; $i++) {
  $fg = [W2]::FgTitle()
  "  第 $i 次前：前台=『$fg』"
  if ($fg -like "*$target*") { "  已经是目标前台，停止 Alt+Tab"; break }
  Inject @(
    @{ t = 'key'; vk = 18; down = 1 },
    @{ t = 'key'; vk = 9; down = 1 },
    @{ t = 'key'; vk = 9; down = 0 },
    @{ t = 'key'; vk = 18; down = 0 }
  )
  Start-Sleep -Milliseconds 700
}
"最终前台=『$([W2]::FgTitle())』"
