using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

// sources.exe -> JSON describing capturable sources:
//   {"monitors":[{"i":0,"x":0,"y":0,"w":2560,"h":1600}],
//    "windows":[{"hwnd":123456,"title":"Notepad","w":800,"h":600}]}
static class Program
{
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
    delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdcMonitor, ref RECT lprcMonitor, IntPtr dwData);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc proc, IntPtr data);
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr data);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    static extern int GetWindowLong(IntPtr hWnd, int index);

    [DllImport("dwmapi.dll")]
    static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);

    // DWMWA_CLOAKED（DWORD）用的重载
    [DllImport("dwmapi.dll")]
    static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);

    static readonly List<string> monitors = new List<string>();
    static readonly List<string> windows = new List<string>();

    static string Esc(string s)
    {
        var sb = new StringBuilder();
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c == '\r' || c == '\n' || c == '\t') sb.Append(' ');
            else if (c < 32) continue;
            else sb.Append(c);
        }
        return sb.ToString();
    }

    static bool MonitorProc(IntPtr h, IntPtr hdc, ref RECT r, IntPtr data)
    {
        monitors.Add("{\"i\":" + monitors.Count + ",\"x\":" + r.Left + ",\"y\":" + r.Top
            + ",\"w\":" + (r.Right - r.Left) + ",\"h\":" + (r.Bottom - r.Top) + "}");
        return true;
    }

    static bool WindowProc(IntPtr hWnd, IntPtr data)
    {
        if (!IsWindowVisible(hWnd)) return true;
        var sb = new StringBuilder(512);
        int n = GetWindowTextW(hWnd, sb, sb.Capacity);
        if (n <= 0) return true;
        string title = sb.ToString();
        if (title.Trim().Length == 0) return true;

        // skip tool windows and cloaked windows
        int ex = GetWindowLong(hWnd, -20);          // GWL_EXSTYLE
        if ((ex & 0x00000080) != 0) return true;    // WS_EX_TOOLWINDOW
        // 注意：**不要**跳过 WS_EX_APPWINDOW（0x40000）—— 绝大多数普通应用的顶层窗口都带这个样式
        // （实测 WinForms 窗口 ex=0x50108），跳过它会让主屏/副屏上的应用窗口从列表里消失。
        int cloaked = 0;
        try { if (DwmGetWindowAttribute(hWnd, 14, out cloaked, Marshal.SizeOf(typeof(int))) != 0) cloaked = 0; } catch { cloaked = 0; }  // DWMWA_CLOAKED
        if (cloaked != 0) return true;              // UWP 隐藏/已关闭但句柄还在的窗口

        RECT r;
        int dwm = DwmGetWindowAttribute(hWnd, 9, out r, Marshal.SizeOf(typeof(RECT)));  // DWMWA_EXTENDED_FRAME_BOUNDS
        if (dwm != 0 && !GetWindowRect(hWnd, out r)) return true;
        int w = r.Right - r.Left, h = r.Bottom - r.Top;
        if (w < 160 || h < 120) return true;

        if (windows.Count >= 60) return false;
        windows.Add("{\"hwnd\":" + hWnd.ToInt64() + ",\"title\":\"" + Esc(title) + "\",\"x\":" + r.Left + ",\"y\":" + r.Top + ",\"w\":" + w + ",\"h\":" + h + "}");
        return true;
    }

    static void Main()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, MonitorProc, IntPtr.Zero);
        EnumWindows(WindowProc, IntPtr.Zero);
        Console.OutputEncoding = Encoding.UTF8;
        Console.Write("{\"monitors\":[" + string.Join(",", monitors.ToArray())
            + "],\"windows\":[" + string.Join(",", windows.ToArray()) + "]}");
    }
}
