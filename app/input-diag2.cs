using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// 诊断 2：输入桌面到底是谁，能不能切过去，切过去之后能不能移动光标
static class D2
{
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr h);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetThreadDesktop(uint tid);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetUserObjectInformation(IntPtr h, int idx, StringBuilder s, int n, out int need);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr h);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }

    static string Name(IntPtr h)
    {
        var sb = new StringBuilder(256); int need;
        return GetUserObjectInformation(h, 2, sb, 256, out need) ? sb.ToString() : "?";
    }

    static void Main()
    {
        var o = new StringBuilder();
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        IntPtr ws = GetProcessWindowStation();
        IntPtr cur = GetThreadDesktop(GetCurrentThreadId());
        o.AppendLine("winsta=" + Name(ws) + " threadDesktop=" + Name(cur));

        POINT p; GetCursorPos(out p);
        o.AppendLine("cursor=" + p.x + "," + p.y);

        bool ok = SetCursorPos(p.x + 1, p.y + 1);
        o.AppendLine("move(+1)= " + ok + " err=" + Marshal.GetLastWin32Error());
        GetCursorPos(out p);
        o.AppendLine("after=" + p.x + "," + p.y);

        // 0x0040 DESKTOP_WRITEOBJECTS | 0x0100 DESKTOP_SWITCHDESKTOP
        IntPtr input = OpenInputDesktop(0, false, 0x0040 | 0x0100 | 0x0001 | 0x0002);
        o.AppendLine("openInputDesktop=" + input + " err=" + Marshal.GetLastWin32Error());
        if (input != IntPtr.Zero)
        {
            o.AppendLine("inputDesktop=" + Name(input));
            bool set = SetThreadDesktop(input);
            o.AppendLine("setThreadDesktop=" + set + " err=" + Marshal.GetLastWin32Error());
            bool mv = SetCursorPos(1200, 900);
            o.AppendLine("afterSwitch move=" + mv + " err=" + Marshal.GetLastWin32Error());
            GetCursorPos(out p);
            o.AppendLine("afterSwitch cursor=" + p.x + "," + p.y);
        }

        File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "input-diag2.log"), o.ToString());
    }
}
