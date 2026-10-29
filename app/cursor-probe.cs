using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// PMv2 感知的光标探针：读到的坐标是物理像素，用来和 /cursor 对照。
static class Probe
{
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }

    static void Main()
    {
        bool aware = false;
        try { aware = SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        if (!aware) { try { aware = SetProcessDPIAware(); } catch { } }

        POINT p; GetCursorPos(out p);
        var log = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "cursor-probe.log");
        File.AppendAllText(log, "pmv2=" + aware + " x=" + p.x + " y=" + p.y + "\r\n");
    }
}
