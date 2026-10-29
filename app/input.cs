using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

// Remote input injector.
//   input.exe <pipeName> <logFile>
// Commands arrive as one JSON-ish line per event, e.g.:
//   {"t":"move","x":640,"y":400}
//   {"t":"down","b":0}   {"t":"up","b":0}   {"t":"click","b":0,"n":1}
//   {"t":"wheel","d":3}
//   {"t":"key","vk":65,"down":1}
//   {"t":"text","s":"hello"}
// Screen coordinates are in virtual-desktop (physical) pixels.
static class Program
{
    const int INPUT_MOUSE = 0;
    const int INPUT_KEYBOARD = 1;

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT
    {
        public int dx, dy;
        public uint mouseData, dwFlags, time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT
    {
        public ushort wVk, wScan;
        public uint dwFlags, time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL, wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct INPUT
    {
        [FieldOffset(0)] public int type;
        [FieldOffset(8)] public MOUSEINPUT mi;
        [FieldOffset(8)] public KEYBDINPUT ki;
        [FieldOffset(8)] public HARDWAREINPUT hi;
    }

    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint MOUSEEVENTF_HWHEEL = 0x01000;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);

    static string logFile;
    static readonly object logLock = new object();

    // 完整性级别：Low 时 UIPI 会拦掉 SendInput/SetCursorPos（err 183/5），必须从 Medium 上下文启动
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr tok);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr tok, int cls, IntPtr buf, int len, out int ret);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);

    static string IntegrityLevel()
    {
        IntPtr tok = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out tok)) return "?";
            int len = 0;
            GetTokenInformation(tok, 25 /*TokenIntegrityLevel*/, IntPtr.Zero, 0, out len);
            IntPtr buf = Marshal.AllocHGlobal(len);
            try
            {
                if (!GetTokenInformation(tok, 25, buf, len, out len)) return "?";
                IntPtr sid = Marshal.ReadIntPtr(buf);   // TOKEN_MANDATORY_LABEL.Label.Sid
                int cnt = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                int rid = Marshal.ReadInt32(GetSidSubAuthority(sid, cnt - 1));
                if (rid >= 0x4000) return "system";
                if (rid >= 0x3000) return "high";
                if (rid >= 0x2000) return "medium";
                if (rid >= 0x1000) return "low";
                return "untrusted";
            }
            finally { Marshal.FreeHGlobal(buf); }
        }
        catch { return "?"; }
        finally { if (tok != IntPtr.Zero) CloseHandle(tok); }
    }
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, int idx);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    static void Log(string msg)
    {
        lock (logLock)
        {
            try { File.AppendAllText(logFile, "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + msg + "\r\n"); }
            catch { }
        }
    }

    // virtual desktop size, needed to convert absolute pixel coords
    static int DeskW() { return GetSystemMetrics(78); }   // SM_CXVIRTUALSCREEN
    static int DeskH() { return GetSystemMetrics(79); }   // SM_CYVIRTUALSCREEN
    static int DeskX() { return GetSystemMetrics(76); }
    static int DeskY() { return GetSystemMetrics(77); }

    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);

    // 绝对定位改用 SetCursorPos：SendInput 的 ABSOLUTE|VIRTUALDESK 在部分多显示器/DPI 组合下会被
    // 系统静默忽略（返回 0），SetCursorPos 稳定可靠，拖拽时的按键状态也照样保持。
    //
    // 注意：前台如果是**高完整性（管理员）窗口**，UIPI 会把注入整段丢掉——SetCursorPos 返回
    // FALSE、SendInput 返回 183，光标纹丝不动，用户看到的就是"点一下好、点一下没反应"。
    // 我们**不**去最小化/关闭那个窗口（UIPI 同样会拦掉，做了也是白做），只把前台切回桌面：
    // SwitchToThisWindow(GetShellWindow()) 不触碰那个高权限窗口，实测不会被拦。
    // 如果 injector 本身以管理员权限运行（见 install-elevated-input.ps1），UIPI 根本不会挡注入。
    static int blockedCount;
    static DateTime lastRecoverAt = DateTime.MinValue;
    static DateTime lastBlockedAt = DateTime.MinValue;   // 最近一次被 UIPI 挡掉的时间（给 /health 报 blkage）

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint to, bool on);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    static void MoveTo(int x, int y)
    {
        if (SetCursorPos(x, y)) return;
        int err = Marshal.GetLastWin32Error();
        Log("setcursorpos failed x=" + x + " y=" + y + " err=" + err);
        int w = DeskW(), h = DeskH();
        if (w > 0 && h > 0)
        {
            var inp = new INPUT[1];
            inp[0].type = INPUT_MOUSE;
            inp[0].mi.dx = (int)Math.Round((x - DeskX()) * 65535.0 / (w - 1));
            inp[0].mi.dy = (int)Math.Round((y - DeskY()) * 65535.0 / (h - 1));
            inp[0].mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
            if (SendInput(1, inp, Marshal.SizeOf(typeof(INPUT))) == 0) Log("sendinput move failed err=" + Marshal.GetLastWin32Error());
        }

        POINT p;
        if (GetCursorPos(out p) && Math.Abs(p.x - x) <= 2 && Math.Abs(p.y - y) <= 2) return;
        BlockedRecover(x, y);                    // 没落到目标点 → 前台管理员窗口挡着，抢回来再试
    }

    // 注入被 UIPI 挡住时的自愈。
    // 前台是高完整性（管理员）窗口时，SetCursorPos 返回 FALSE、SendInput 返回 183，注入整段被丢掉，
    // 用户看到的就是"点一下好、点一下没反应"。AttachThreadInput + SetForegroundWindow 在 Win10/11 上
    // 常被前台锁拒绝，实测 SwitchToThisWindow（老 API，不受前台锁约束）能把前台踢回桌面 Program Manager，
    // 之后注入立刻恢复。所以先试 SwitchToThisWindow，再重试落点。
    [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool altTab);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    const int SW_RESTORE = 9;
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);

    static string ForegroundTitle()
    {
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) return "(none)";
        var t = new StringBuilder(160);
        GetWindowText(fg, t, 160);
        if (t.Length > 0) return t.ToString();
        var c = new StringBuilder(160);
        GetClassName(fg, c, 160);
        return "[" + c + "]";
    }

    static void BlockedRecover(int x, int y)
    {
        blockedCount++;
        lastBlockedAt = DateTime.UtcNow;
        if ((DateTime.UtcNow - lastRecoverAt).TotalSeconds < 1) return;
        lastRecoverAt = DateTime.UtcNow;
        string who = ForegroundTitle();
        IntPtr shell = GetShellWindow();
        for (int i = 0; i < 4; i++)
        {
            if (shell != IntPtr.Zero) SwitchToThisWindow(shell, true);
            Thread.Sleep(130);                   // 前台切换是异步的，要多等一会
            if (SetCursorPos(x, y))
            {
                if (i > 0 || blockedCount < 5) Log("blocked by '" + who + "' #" + blockedCount + " -> took desktop back (" + (i + 1) + " try)");
                return;
            }
        }
        Log("blocked by '" + who + "' #" + blockedCount + " -> still blocked, close that elevated window");
    }

    static void RecoverForeground()
    {
        if ((DateTime.UtcNow - lastRecoverAt).TotalSeconds < 2) return;
        lastRecoverAt = DateTime.UtcNow;
        IntPtr shell = GetShellWindow();
        if (shell != IntPtr.Zero) SwitchToThisWindow(shell, true);
        Thread.Sleep(70);
    }

    static void Button(uint downFlag, uint upFlag, bool down)
    {
        var inp = new INPUT[1];
        inp[0].type = INPUT_MOUSE;
        inp[0].mi.dwFlags = down ? downFlag : upFlag;
        if (SendInput(1, inp, Marshal.SizeOf(typeof(INPUT))) != 0) return;
        Log("sendinput failed err=" + Marshal.GetLastWin32Error());
        RecoverForeground();                       // 前台被管理员窗口占着 → 踢回桌面再试
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    static uint FlagFor(int b, bool down)
    {
        if (b == 1) return down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
        if (b == 2) return down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
        return down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
    }

    static void Wheel(int delta)
    {
        var inp = new INPUT[1];
        inp[0].type = INPUT_MOUSE;
        inp[0].mi.dwFlags = MOUSEEVENTF_WHEEL;
        inp[0].mi.mouseData = unchecked((uint)(delta * 120));
        if (SendInput(1, inp, Marshal.SizeOf(typeof(INPUT))) == 0) Log("sendinput failed err=" + Marshal.GetLastWin32Error());
    }

    static void HWheel(int delta)
    {
        var inp = new INPUT[1];
        inp[0].type = INPUT_MOUSE;
        inp[0].mi.dwFlags = MOUSEEVENTF_HWHEEL;
        inp[0].mi.mouseData = unchecked((uint)(delta * 120));
        if (SendInput(1, inp, Marshal.SizeOf(typeof(INPUT))) == 0) Log("sendinput failed err=" + Marshal.GetLastWin32Error());
    }

    static void Key(int vk, bool down)
    {
        var inp = new INPUT[1];
        inp[0].type = INPUT_KEYBOARD;
        inp[0].ki.wVk = (ushort)vk;
        inp[0].ki.dwFlags = down ? 0 : KEYEVENTF_KEYUP;
        if (SendInput(1, inp, Marshal.SizeOf(typeof(INPUT))) == 0) Log("sendinput failed err=" + Marshal.GetLastWin32Error());
    }

    static void Text(string s)
    {
        foreach (char ch in s)
        {
            var inp = new INPUT[2];
            inp[0].type = INPUT_KEYBOARD;
            inp[0].ki.wScan = ch;
            inp[0].ki.dwFlags = KEYEVENTF_UNICODE;
            inp[1].type = INPUT_KEYBOARD;
            inp[1].ki.wScan = ch;
            inp[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            SendInput(2, inp, Marshal.SizeOf(typeof(INPUT)));
        }
    }

    // tiny JSON reader: we only need flat {key: value} objects
    static Dictionary<string, string> Parse(string line)
    {
        var d = new Dictionary<string, string>();
        int i = 0;
        while (i < line.Length)
        {
            int k = line.IndexOf('"', i);
            if (k < 0) break;
            int k2 = line.IndexOf('"', k + 1);
            if (k2 < 0) break;
            string key = line.Substring(k + 1, k2 - k - 1);
            int colon = line.IndexOf(':', k2);
            if (colon < 0) break;
            int v = colon + 1;
            while (v < line.Length && (line[v] == ' ' || line[v] == '\t')) v++;
            string val;
            if (v < line.Length && line[v] == '"')
            {
                int e = v + 1;
                var sb = new StringBuilder();
                while (e < line.Length && line[e] != '"')
                {
                    if (line[e] == '\\' && e + 1 < line.Length)
                    {
                        e++;
                        switch (line[e])
                        {
                            case 'n': sb.Append('\n'); break;
                            case 't': sb.Append('\t'); break;
                            case '"': sb.Append('"'); break;
                            case '\\': sb.Append('\\'); break;
                            case 'u':
                                if (e + 4 < line.Length)
                                {
                                    sb.Append((char)Convert.ToInt32(line.Substring(e + 1, 4), 16));
                                    e += 4;
                                }
                                break;
                            default: sb.Append(line[e]); break;
                        }
                    }
                    else sb.Append(line[e]);
                    e++;
                }
                val = sb.ToString();
                i = e + 1;
            }
            else
            {
                int e = v;
                while (e < line.Length && line[e] != ',' && line[e] != '}') e++;
                val = line.Substring(v, e - v).Trim();
                i = e;
            }
            if (!d.ContainsKey(key)) d[key] = val;
        }
        return d;
    }

    static int I(Dictionary<string, string> d, string k, int def)
    {
        string s;
        if (d.TryGetValue(k, out s))
        {
            int n;
            if (int.TryParse(s, out n)) return n;
        }
        return def;
    }

    static void Handle(string line, StreamWriter reply)
    {
        if (line.Length == 0) return;
        var d = Parse(line);
        string t;
        if (!d.TryGetValue("t", out t)) return;
        switch (t)
        {
            case "move": MoveTo(I(d, "x", 0), I(d, "y", 0)); break;
            case "down": Button(FlagFor(I(d, "b", 0), true), FlagFor(I(d, "b", 0), false), true); break;
            case "up": Button(FlagFor(I(d, "b", 0), true), FlagFor(I(d, "b", 0), false), false); break;
            case "click":
            {
                int b = I(d, "b", 0);
                int n = I(d, "n", 1);
                for (int i = 0; i < n; i++)
                {
                    Button(FlagFor(b, true), FlagFor(b, false), true);
                    Button(FlagFor(b, true), FlagFor(b, false), false);
                }
                break;
            }
            case "wheel": Wheel(I(d, "d", 0)); break;
            case "hwheel": HWheel(I(d, "d", 0)); break;
            case "key": Key(I(d, "vk", 0), I(d, "down", 1) != 0); break;
            case "text": { string s; if (d.TryGetValue("s", out s)) Text(s); break; }
            case "cursor":
            {
                POINT p; GetCursorPos(out p);
                if (reply != null)
                {
                    try
                    {
                        reply.WriteLine("{\"cx\":" + p.x + ",\"cy\":" + p.y +
                                        ",\"blocked\":" + blockedCount +
                                        ",\"blkage\":" + BlockAgeMs() +
                                        ",\"fg\":\"" + Esc(ForegroundTitle()) + "\"}");
                        reply.Flush();
                    }
                    catch { }
                }
                break;
            }
            case "hello": Log("client connected"); break;
            case "unblock":
            {
                bool ok = ForceUnblock();
                if (reply != null)
                {
                    try { reply.WriteLine("{\"unblock\":" + (ok ? 1 : 0) + ",\"fg\":\"" + Esc(ForegroundTitle()) + "\"}"); reply.Flush(); }
                    catch { }
                }
                break;
            }
            case "status":
            {
                if (reply != null)
                {
                    try { reply.WriteLine("{\"blocked\":" + blockedCount + ",\"blkage\":" + BlockAgeMs() + ",\"fg\":\"" + Esc(ForegroundTitle()) + "\"}"); reply.Flush(); }
                    catch { }
                }
                break;
            }
            case "focus":
            {
                // 把指定窗口提到最前面（切抓屏来源时用）。High 完整性进程可以做这件事，
                // 前台锁/提权窗口都拦不住；失败就静默返回 0。
                int hwnd = I(d, "hwnd", 0);
                bool ok = hwnd != 0 && RaiseWindow(new IntPtr(hwnd));
                if (reply != null)
                {
                    try { reply.WriteLine("{\"focus\":" + (ok ? 1 : 0) + ",\"fg\":\"" + Esc(ForegroundTitle()) + "\"}"); reply.Flush(); }
                    catch { }
                }
                break;
            }
        }
    }

    // 把窗口切到前台。前台锁（foreground lock）会拒绝 SetForegroundWindow，
    // 所以依次试：直接 SetForegroundWindow → SwitchToThisWindow → 模拟一次 Alt（解锁前台锁）
    // → AttachThreadInput 到当前前台线程再 SetForegroundWindow。
    static bool RaiseWindow(IntPtr h)
    {
        if (h == IntPtr.Zero) return false;
        try
        {
            if (!IsWindow(h)) return false;
            if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
            if (GetForegroundWindow() == h) { Log("focus ok 0x" + h.ToString("X") + " (already)"); return true; }

            SetForegroundWindow(h);
            Thread.Sleep(60);
            if (GetForegroundWindow() == h) { Log("focus ok 0x" + h.ToString("X") + " (setfg)"); return true; }

            SwitchToThisWindow(h, true);
            Thread.Sleep(80);
            if (GetForegroundWindow() == h) { Log("focus ok 0x" + h.ToString("X") + " (switch)"); return true; }

            // Alt 键解锁前台锁（老技巧）：任何进程收到 Alt 后都临时获得前台切换权
            Key(0x12, true); Key(0x12, false);
            Thread.Sleep(40);
            SetForegroundWindow(h);
            Thread.Sleep(80);
            if (GetForegroundWindow() == h) { Log("focus ok 0x" + h.ToString("X") + " (alt)"); return true; }

            // 挂到当前前台线程上再切
            IntPtr fg = GetForegroundWindow();
            uint pid;
            uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out pid);
            uint myThread = GetCurrentThreadId();
            if (fgThread != 0 && fgThread != myThread)
            {
                bool attached = AttachThreadInput(myThread, fgThread, true);
                SetForegroundWindow(h);
                AttachThreadInput(myThread, fgThread, false);
                Thread.Sleep(80);
                bool ok2 = GetForegroundWindow() == h;
                Log("focus 0x" + h.ToString("X") + (ok2 ? " ok (attach)" : " failed (attach=" + attached + ")"));
                return ok2;
            }

            Log("focus 0x" + h.ToString("X") + " failed (fg=0x" + fg.ToString("X") + ")");
            return false;
        }
        catch (Exception ex) { Log("focus error: " + ex.Message); return false; }
    }

    // 距最近一次被挡多少毫秒（-1 = 从来没被挡过）
    static long BlockAgeMs()
    {
        if (lastBlockedAt == DateTime.MinValue) return -1;
        return (long)(DateTime.UtcNow - lastBlockedAt).TotalMilliseconds;
    }
    static string Esc(string s)
    {
        if (s == null) return "";
        var sb = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < ' ') sb.Append(' ');
            else sb.Append(c);
        }
        return sb.ToString();
    }

    // 用户在页面上点"抢回前台"时调用：无视速率限制，狠狠地试几轮
    static bool ForceUnblock()
    {
        lastRecoverAt = DateTime.MinValue;
        IntPtr shell = GetShellWindow();
        for (int i = 0; i < 6; i++)
        {
            if (shell != IntPtr.Zero) SwitchToThisWindow(shell, true);
            Thread.Sleep(120);
            if (CanInject())
            {
                Log("manual unblock ok (try " + (i + 1) + ", was blocked by '" + ForegroundTitle() + "')");
                return true;
            }
        }
        Log("manual unblock failed, still blocked by '" + ForegroundTitle() + "'");
        return false;
    }

    // 试探：把光标挪 1 像素再挪回来，能挪动就说明注入没被挡
    static bool CanInject()
    {
        POINT p;
        if (!GetCursorPos(out p)) return false;
        int x = p.x > 10 ? p.x - 1 : p.x + 1;
        if (!SetCursorPos(x, p.y)) return false;
        SetCursorPos(p.x, p.y);
        return true;
    }

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);

    // 进程必须声明 per-monitor-DPI 感知：否则在 150% 缩放的屏幕上，SetCursorPos/GetCursorPos 用的是
    // 被系统虚拟化过的"逻辑像素"，与 capture.exe 抓到的物理像素差一个缩放倍数（点哪偏哪）。
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    static void EnableDpiAwareness()
    {
        // -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
        try { SetProcessDPIAware(); } catch { }
    }

    static void Serve(string pipeName)
    {
        while (true)
        {
            NamedPipeServerStream s = null;
            try
            {
                // 以管理员权限运行时（High 完整性），默认管道的 DACL 会把普通权限的服务端挡在外面，
                // 报 EPERM。这里显式给 Everyone 完全访问，让 Medium 的 screen-server.mjs 也能连。
                var ps = new PipeSecurity();
                ps.AddAccessRule(new PipeAccessRule(
                    new SecurityIdentifier(WellKnownSidType.WorldSid, null),
                    PipeAccessRights.FullControl, AccessControlType.Allow));
                s = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1,
                    PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096, ps);
                s.WaitForConnection();
                Log("pipe client connected");
                var reader = new StreamReader(s, Encoding.UTF8);
                var writer = new StreamWriter(s, new UTF8Encoding(false));
                writer.AutoFlush = true;
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    if (line.IndexOf("\"cursor\"") < 0) Log("line: " + line);   // 光标轮询太频繁，不记日志
                    try { Handle(line.Trim(), writer); } catch (Exception he) { Log("handle error: " + he.Message); }
                }
            }
            catch (Exception e) { Log("pipe error: " + e.Message); }
            finally { try { if (s != null) s.Dispose(); } catch { } }
            Thread.Sleep(200);
        }
    }

    static void Main(string[] args)
    {
        EnableDpiAwareness();
        string pipeName = args.Length > 0 ? args[0] : "dsh-input";
        logFile = args.Length > 1 ? args[1] : Path.Combine(Path.GetTempPath(), "dsh-input.log");
        Log("input service start pipe=" + pipeName + " integrity=" + IntegrityLevel());
        Serve(pipeName);
    }
}
