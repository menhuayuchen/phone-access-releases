using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// 诊断 3：winexe + WMI 启动（和 input.exe 同一种进程），试 SwitchToThisWindow 抢前台
static class D3
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool altTab);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool on);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }

    static string Fg()
    {
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero) return "(none)";
        var sb = new StringBuilder(160);
        GetWindowText(h, sb, 160);
        return sb.Length > 0 ? sb.ToString() : "[empty]";
    }

    static void Main()
    {
        var o = new StringBuilder();
        o.AppendLine("fg0=" + Fg());
        IntPtr shell = GetShellWindow();
        o.AppendLine("shell=" + shell);

        SwitchToThisWindow(shell, true);
        Thread.Sleep(300);
        o.AppendLine("afterSwitch fg=" + Fg());
        o.AppendLine("setcursorpos=" + SetCursorPos(700, 500));

        // 备选：AttachThreadInput + SetForegroundWindow
        IntPtr fg = GetForegroundWindow();
        uint pid;
        uint fgT = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out pid) : 0;
        bool at = fgT != 0 && AttachThreadInput(GetCurrentThreadId(), fgT, true);
        bool sf = SetForegroundWindow(shell);
        if (at) AttachThreadInput(GetCurrentThreadId(), fgT, false);
        Thread.Sleep(300);
        o.AppendLine("attach=" + at + " setfg=" + sf + " fg=" + Fg());
        o.AppendLine("setcursorpos2=" + SetCursorPos(700, 500));

        POINT p; GetCursorPos(out p);
        o.AppendLine("cursor=" + p.x + "," + p.y);
        File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "input-diag3.log"), o.ToString());
    }
}
