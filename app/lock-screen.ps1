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
    [string]$HookFile = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

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
}
"@
}

# 防窥屏期间拦掉"能从遮罩里逃出去"的快捷键：所有 Win 组合、Alt+Tab、Alt+Esc、Alt+F4、Ctrl+Esc、Ctrl+Shift+Esc。
# 关键：只拦**物理键盘**。远端注入的按键（SendInput）带 LLKHF_INJECTED 标志，必须放行，
# 否则手机上的 Alt+Tab 等快捷键会被自己拦掉。Ctrl+Alt+Del 是系统级安全序列，钩子拦不住，属正常。
if (-not ('HotkeyGuard' -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class HotkeyGuard {
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int LLKHF_INJECTED = 0x10;
    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
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
    private static IntPtr hook = IntPtr.Zero;
    private static LowLevelKeyboardProc proc = HookCallback;
    private static bool enabled = false;
    public static bool Enabled { get { return enabled; } }
    public static bool Start() {
        if (hook != IntPtr.Zero) return true;
        hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(null), 0);
        enabled = hook != IntPtr.Zero;
        return enabled;
    }
    public static void Stop() {
        if (hook != IntPtr.Zero) { UnhookWindowsHookEx(hook); hook = IntPtr.Zero; enabled = false; }
    }
    private static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        try {
            if (nCode >= 0 && enabled) {
                int msg = (int)wParam;
                if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
                    KBDLLHOOKSTRUCT k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                    if ((k.flags & LLKHF_INJECTED) == 0) {
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
        return CallNextHookEx(hook, nCode, wParam, lParam);
    }
}
"@
}

$hookStarted = $false
if ($BlockHotkeys) {
    try { $hookStarted = [HotkeyGuard]::Start() } catch { $hookStarted = $false }
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
        $f = New-Object System.Windows.Forms.Form
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
            try { [void][LockWinApi]::SetWindowDisplayAffinity($f.Handle, [uint32]$WDA_EXCLUDEFROMCAPTURE) } catch { }
        }
        $forms += $f
    }
    if ($forms.Count -gt 0) {
        try { [void]$forms[0].Activate() } catch { }
        try { [void]$forms[0].Focus() } catch { }
    }
    for ($i = 0; $i -lt 8; $i++) { if ([LockWinApi]::ShowCursor($false) -lt 0) { $hiddenCursor++; break } else { $hiddenCursor++ } }

    $start = Get-Date
    while ($true) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 80
        if ($StopFile -and (Test-Path -LiteralPath $StopFile)) { break }
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
