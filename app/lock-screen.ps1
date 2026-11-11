# 防窥屏（privacy mode）：在被控电脑的每块屏幕最上层盖一个全屏窗口。
#
# 关键点：SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) 让窗口**不出现在屏幕捕获里**，
# 所以本机的人只看到黑屏/自定义图，而远端控制者通过 ddagrab 捕获仍然看到真实桌面。
#
# 用法（由 screen-server 拉起，不直接给客户用）：
#   powershell -File lock-screen.ps1 -ImagePath "锁屏图.png" -StopFile "privacy.stop"
#     -ImagePath 省略 = 纯黑
#     -StopFile  出现这个文件就退出（服务端删/建文件来关）
#     -HoldSeconds 调试用：N 秒后自动退出（0 = 一直显示）
#     -TestColor  调试用：用纯色块代替锁屏图（配合截图检测"是否被捕获"）
#
# 退出：窗口关闭 / StopFile 出现 / 进程被杀。服务端会同时删除 StopFile。
# UTF-8 with BOM，PS 5.1。
param(
    [string]$ImagePath = '',
    [string]$StopFile = '',
    [string]$BeatFile = '',
    [int]$ParentPid = 0,
    [string]$TestColor = '',
    [int]$HoldSeconds = 0,
    [int]$MaxMinutes = 480,
    [switch]$DisableExclude,
    [switch]$BlockHotkeys,
    [switch]$LockInput,
    [switch]$WakeOnInput,
    [string]$HookFile = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 遮罩窗口的"鼠标穿透"：WM_NCHITTEST 一律回 HTTRANSPARENT(-1)，
# 让鼠标消息落到**下面真正的窗口**上。实测只设 WS_EX_TRANSPARENT 不够
# （WindowFromPoint 仍然命中遮罩，表现为"只能看不能操作"）。
if (-not ('CoverForm' -as [type])) {
    Add-Type -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing' -TypeDefinition @"
using System;
using System.Windows.Forms;
public class CoverForm : Form {
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0084) { m.Result = (IntPtr)(-1); return; }   // WM_NCHITTEST -> HTTRANSPARENT
        base.WndProc(ref m);
    }
}
"@
}

if (-not ('LockWinApi' -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LockWinApi {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);
    [DllImport("user32.dll")]
    public static extern int ShowCursor(bool bShow);
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);
    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint crKey, byte bAlpha, uint dwFlags);
}
"@
}

# 防窥屏期间的输入拦截，分两档：
#  ① 基础（始终）：拦"能从遮罩里逃出去"的物理快捷键——所有 Win 组合、Alt+Tab/Esc/F4、Ctrl+Esc、Ctrl+Shift+Esc；
#  ② 加强（-LockInput，设置里可关）：把电脑前的**物理键盘和鼠标**全部吞掉，本机彻底动不了。
# 关键：只拦**物理**输入。远端注入（SendInput）带 INJECTED 标志，一律放行，
# 否则手机上的鼠标/快捷键会被自己的钩子拦掉。Ctrl+Alt+Del 是系统安全序列，拦不住，属正常。
if (-not ('HotkeyGuard' -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class HotkeyGuard {
    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int LLKHF_INJECTED = 0x10;
    private const int LLMHF_INJECTED = 0x01;
    private delegate IntPtr LowLevelProc(int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);
    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT { public int vkCode; public int scanCode; public int flags; public int time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT { public int ptX; public int ptY; public int mouseData; public int flags; public int time; public IntPtr dwExtraInfo; }
    private static IntPtr kbHook = IntPtr.Zero;
    private static IntPtr msHook = IntPtr.Zero;
    private static LowLevelProc kbProc = KeyboardCallback;
    private static LowLevelProc msProc = MouseCallback;
    private static bool enabled = false;
    private static bool lockAll = false;
    private static bool watchInput = false;
    // 2026-11-11：息屏后"人走过去敲键盘/动鼠标就亮"。只认**真人输入**——远程控制是 SendInput 注入的，
    // 带 LLKHF_INJECTED / LLMHF_INJECTED 标志，不计入（否则手机点一下就把屏幕点亮了）。
    public static volatile bool LocalInput = false;
    public static bool Enabled { get { return enabled; } }
    public static bool Start(bool lockEverything, bool watchLocalInput) {
        lockAll = lockEverything;
        watchInput = watchLocalInput;
        if (kbHook == IntPtr.Zero) kbHook = SetWindowsHookEx(WH_KEYBOARD_LL, kbProc, GetModuleHandle(null), 0);
        if ((lockAll || watchInput) && msHook == IntPtr.Zero) msHook = SetWindowsHookEx(WH_MOUSE_LL, msProc, GetModuleHandle(null), 0);
        enabled = kbHook != IntPtr.Zero && (!lockAll || msHook != IntPtr.Zero);
        return enabled;
    }
    public static void Stop() {
        if (kbHook != IntPtr.Zero) { UnhookWindowsHookEx(kbHook); kbHook = IntPtr.Zero; }
        if (msHook != IntPtr.Zero) { UnhookWindowsHookEx(msHook); msHook = IntPtr.Zero; }
        enabled = false;
    }
    private static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
    private static IntPtr KeyboardCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        try {
            if (nCode >= 0 && enabled) {
                KBDLLHOOKSTRUCT k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                if ((k.flags & LLKHF_INJECTED) == 0) {
                    LocalInput = true;
                    if (lockAll) return (IntPtr)1;
                    int msg = (int)wParam;
                    if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
                        int vk = k.vkCode;
                        bool win = Down(0x5B) || Down(0x5C);
                        bool alt = Down(0x12);
                        bool ctrl = Down(0x11);
                        bool shift = Down(0x10);
                        bool blocked = false;
                        if (win) blocked = true;
                        else if (alt && (vk == 0x09 || vk == 0x1B || vk == 0x73)) blocked = true;
                        else if (ctrl && vk == 0x1B) blocked = true;
                        else if (ctrl && shift && vk == 0x1B) blocked = true;
                        if (blocked) return (IntPtr)1;
                    }
                }
            }
        } catch { }
        return CallNextHookEx(kbHook, nCode, wParam, lParam);
    }
    private static IntPtr MouseCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        try {
            if (nCode >= 0 && enabled && (lockAll || watchInput)) {
                MSLLHOOKSTRUCT m = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                if ((m.flags & LLMHF_INJECTED) == 0) {
                    LocalInput = true;
                    if (lockAll) return (IntPtr)1;
                }
            }
        } catch { }
        return CallNextHookEx(msHook, nCode, wParam, lParam);
    }
}
"@
}

$hookStarted = $false
if ($BlockHotkeys -or $LockInput) {
    try { $hookStarted = [HotkeyGuard]::Start([bool]$LockInput, [bool]$WakeOnInput) } catch { $hookStarted = $false }
    if ($HookFile) { try { Set-Content -LiteralPath $HookFile -Value ($(if ($hookStarted) { 'ok' } else { 'fail' })) -Encoding ASCII } catch { } }
}

$WDA_EXCLUDEFROMCAPTURE = 0x00000011
$ES_CONTINUOUS = 0x80000000
$ES_DISPLAY_REQUIRED = 0x00000002
$ES_SYSTEM_REQUIRED = 0x00000001

# 不让系统休眠/关屏：防窥屏期间屏幕由我们控制
try { [void][LockWinApi]::SetThreadExecutionState([uint32]($ES_CONTINUOUS -bor $ES_DISPLAY_REQUIRED -bor $ES_SYSTEM_REQUIRED)) } catch { }

$lockImage = $null
if ($ImagePath -and (Test-Path -LiteralPath $ImagePath)) {
    try { $lockImage = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $ImagePath).Path) } catch { $lockImage = $null }
}

$backColor = [System.Drawing.Color]::Black
if ($TestColor) {
    try { $backColor = [System.Drawing.ColorTranslator]::FromHtml($TestColor) } catch { }
}

$forms = @()
$hiddenCursor = 0
try {
    foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
        $f = New-Object CoverForm
        $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
        $f.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
        $f.Bounds = $screen.Bounds
        $f.TopMost = $true
        $f.ShowInTaskbar = $false
        $f.BackColor = $backColor
        $f.MinimizeBox = $false
        $f.MaximizeBox = $false
        $f.ControlBox = $false
        if ($lockImage) {
            $f.BackgroundImage = $lockImage
            $f.BackgroundImageLayout = [System.Windows.Forms.ImageLayout]::Stretch
        }
        # Alt+F4 / 点关闭 都拦掉；脚本自己要退出时把 allowClose 放开
        $global:lockScreenAllowClose = $false
        $f.Add_FormClosing({ param($s, $e) if (-not $global:lockScreenAllowClose) { $e.Cancel = $true } })
        $f.Show()
        if (-not $DisableExclude) {
            # 点击穿透 + 不抢焦点：远端注入的鼠标必须落到下面真正的窗口上，
            # 否则遮罩一开就只能看、不能操作（2026-11-05 用户实测的 bug）。
            try {
                $GWL_EXSTYLE = -20
                $WS_EX_TRANSPARENT = 0x20
                $WS_EX_NOACTIVATE = 0x08000000
                $WS_EX_LAYERED = 0x00080000
                $st = [LockWinApi]::GetWindowLong($f.Handle, $GWL_EXSTYLE)
                # WS_EX_TRANSPARENT 必须配合 WS_EX_LAYERED 才能把鼠标放给**其他进程**的窗口
                # （HTTRANSPARENT 只在同线程内转发）。分层窗口默认 alpha=0 不可见，显式设 255。
                [void][LockWinApi]::SetWindowLong($f.Handle, $GWL_EXSTYLE, ($st -bor $WS_EX_TRANSPARENT -bor $WS_EX_NOACTIVATE -bor $WS_EX_LAYERED))
                [void][LockWinApi]::SetLayeredWindowAttributes($f.Handle, 0, 255, 0x2)
            } catch { }
            try { [void][LockWinApi]::SetWindowDisplayAffinity($f.Handle, [uint32]$WDA_EXCLUDEFROMCAPTURE) } catch { }
        }
        $forms += $f
    }
    for ($i = 0; $i -lt 8; $i++) { if ([LockWinApi]::ShowCursor($false) -lt 0) { $hiddenCursor++; break } else { $hiddenCursor++ } }

    $start = Get-Date
    while ($true) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 80
        if ($StopFile -and (Test-Path -LiteralPath $StopFile)) { break }
        # 2026-11-11：息屏后真人敲键盘/动鼠标 → 立刻退出遮罩（服务端会同时把背光还原）
        if ($WakeOnInput -and [HotkeyGuard]::LocalInput) { break }
        if ($HoldSeconds -gt 0 -and ((Get-Date) - $start).TotalSeconds -ge $HoldSeconds) { break }
        if ($forms.Count -eq 0) { break }
        # 保命三件套：服务端进程没了 / 心跳文件过期 / 超过最长时长 —— 任何一条都立刻撤窗口，
        # 绝不能让电脑本机被一块关不掉的黑屏卡住（服务端崩溃/被杀时靠这些自动解锁）。
        if ($ParentPid -gt 0) {
            $pp = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
            if (-not $pp) { break }
        }
        if ($BeatFile) {
            try {
                if (-not (Test-Path -LiteralPath $BeatFile)) { break }
                if (((Get-Date) - (Get-Item -LiteralPath $BeatFile).LastWriteTime).TotalSeconds -gt 20) { break }
            } catch { break }
        }
        if ($MaxMinutes -gt 0 -and ((Get-Date) - $start).TotalMinutes -ge $MaxMinutes) { break }
    }
} finally {
    $global:lockScreenAllowClose = $true
    try { if ($hookStarted) { [HotkeyGuard]::Stop() } } catch { }
    for ($i = 0; $i -lt $hiddenCursor; $i++) { [void][LockWinApi]::ShowCursor($true) }
    foreach ($f in $forms) { try { $f.Hide(); $f.Close(); $f.Dispose() } catch { } }
    if ($lockImage) { try { $lockImage.Dispose() } catch { } }
    try { [void][LockWinApi]::SetThreadExecutionState([uint32]$ES_CONTINUOUS) } catch { }
}
