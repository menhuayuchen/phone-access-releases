using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// 诊断：能不能移动光标 / 能不能注入鼠标点击
static class T
{
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] i, int cb);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint tid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true)] static extern bool OpenInputDesktop(uint flags, bool inherit, uint access);
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(4)] public MOUSEINPUT mi; }

    static void Main()
    {
        var sb = new StringBuilder();
        bool aware = false;
        try { aware = SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        sb.AppendLine("pmv2=" + aware);

        POINT a; GetCursorPos(out a);
        sb.AppendLine("before=" + a.x + "," + a.y);

        bool moved = SetCursorPos(500, 500);
        int e1 = Marshal.GetLastWin32Error();
        POINT b; GetCursorPos(out b);
        sb.AppendLine("setcursorpos=" + moved + " err=" + e1 + " after=" + b.x + "," + b.y);

        var inp = new INPUT[1];
        inp[0].type = 0;                       // INPUT_MOUSE
        inp[0].mi.dwFlags = 0x0002;            // LEFTDOWN
        uint r1 = SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
        int e2 = Marshal.GetLastWin32Error();
        inp[0].mi.dwFlags = 0x0004;            // LEFTUP
        uint r2 = SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
        int e3 = Marshal.GetLastWin32Error();
        sb.AppendLine("sendinput down=" + r1 + " err=" + e2 + " up=" + r2 + " err=" + e3);
        sb.AppendLine("winsta=" + GetProcessWindowStation() + " desktop=" + GetThreadDesktop(GetCurrentThreadId()) + " tid=" + GetCurrentThreadId());
        bool od = OpenInputDesktop(0, false, 0x0100);
        sb.AppendLine("openinputdesktop=" + od + " err=" + Marshal.GetLastWin32Error());

        File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "input-diag.log"), sb.ToString());
    }
}
