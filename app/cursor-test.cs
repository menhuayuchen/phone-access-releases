using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class T
{
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint tid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool GetUserObjectInformation(IntPtr h, int idx, StringBuilder buf, int len, out int need);

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }

    static string Name(IntPtr h)
    {
        var sb = new StringBuilder(256); int need;
        if (GetUserObjectInformation(h, 2, sb, 512, out need)) return sb.ToString();
        return "?err" + Marshal.GetLastWin32Error();
    }

    static void Main()
    {
        var log = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "cursor-test.log");
        var sb2 = new StringBuilder();
        sb2.AppendLine("session=" + Process.GetCurrentProcess().SessionId);
        sb2.AppendLine("winsta=" + Name(GetProcessWindowStation()));
        sb2.AppendLine("desktop=" + Name(GetThreadDesktop(GetCurrentThreadId())));
        POINT p; GetCursorPos(out p);
        sb2.AppendLine("cursor=" + p.x + "," + p.y);
        bool ok = SetCursorPos(p.x + 5, p.y + 5);
        sb2.AppendLine("setcursorpos ok=" + ok + " err=" + Marshal.GetLastWin32Error());
        POINT q; GetCursorPos(out q);
        sb2.AppendLine("after=" + q.x + "," + q.y);
        File.WriteAllText(log, sb2.ToString());
    }
}
