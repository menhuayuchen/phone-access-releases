Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinScan {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    public static List<string> List() {
        var r = new List<string>();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h)) return true;
            var t = new StringBuilder(256); GetWindowText(h, t, 256);
            var c = new StringBuilder(256); GetClassName(h, c, 256);
            uint p; GetWindowThreadProcessId(h, out p);
            r.Add(((long)h).ToString("X") + "|" + p + "|" + c + "|" + t);
            return true;
        }, IntPtr.Zero);
        return r;
    }
}
'@

$fg = [WinScan]::GetForegroundWindow()
"foreground hwnd=0x{0:X}" -f [int64]$fg
"--- 可见窗口 ---"
foreach ($row in ([WinScan]::List() | Sort-Object)) {
    $parts = $row -split '\|', 4
    if ([string]::IsNullOrWhiteSpace($parts[3])) { continue }
    $proc = Get-Process -Id ([int]$parts[1]) -ErrorAction SilentlyContinue
    $exe = if ($proc) { $proc.ProcessName } else { '?' }
    # 提权进程的 Path 读不到 → 用作"管理员窗口"的近似判据
    $elev = if ($proc) { if ($proc.Path) { 'medium' } else { 'ELEVATED?' } } else { '?' }
    $mark = if ($parts[1] -eq '') { '' } else { '' }
    "  hwnd=$($parts[0]) pid=$($parts[1]) [$elev] $exe  class=$($parts[2])  title=$($parts[3])"
}
