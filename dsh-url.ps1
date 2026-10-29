<#
.SYNOPSIS
    DSH 对话控制台 · 按需开关（卖家自用工具，不进客户产品）

.DESCRIPTION
    问题（实测）：
      · DSH 桌面版只监听 127.0.0.1，手机连不到，必须有代理转发到 tailnet
      · 代理要 /go?k= 就必须有登录令牌，令牌只在「产品自己启动 dsh web」时写进 web-lan.log
      · 但那个 dsh web 占约 400MB，和抓屏抢 CPU，会让画面帧率从 24 掉到 9~18

    所以做成**按需**：
      · 不带参数 -> 启动 dsh web + 三扇门，打印手机网址（用的时候才开）
      · -Stop    -> 全部关掉，把 CPU 还给抓屏
      · -Status  -> 只看状态

.NOTES
    UTF-8 with BOM，PS 5.1。需要管理员权限（要改 tailscale serve）。
#>
param(
    [switch]$Stop,
    [switch]$Status,
    [switch]$NoPause
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$inst = Join-Path $env:LOCALAPPDATA 'PhoneAccess'
if (-not (Test-Path (Join-Path $inst 'screen-server.mjs'))) { $inst = $here }

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Ok([string]$m) { Write-Host ('  [OK] ' + $m) -ForegroundColor Green }
function Warn([string]$m) { Write-Host ('  [!] ' + $m) -ForegroundColor Yellow }

. (Join-Path $inst 'product-config.ps1')
. (Join-Path $inst 'dsh-port.ps1')
$cfg = Get-ProductConfig -AppDir $inst
$dshPort = [int]$cfg.ports.dsh
$tailPort = [int]$cfg.ports.door
$screenPort = [int]$cfg.ports.screen

$node = Join-Path $inst 'runtime\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }
$log = Join-Path $inst 'web-lan.log'
$keyFile = Join-Path $inst 'screen.key'

function Get-Listeners { param([int]$p) @(Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) }

function Get-DshToken {
    # 令牌由 dsh web 启动时打印在 web-lan.log 里：?token=xxxx
    if (-not (Test-Path $log)) { return $null }
    $t = [System.IO.File]::ReadAllText($log)
    $m = [regex]::Matches($t, 'token=([A-Za-z0-9_\-]{16,})')
    if ($m.Count -eq 0) { return $null }
    return $m[$m.Count - 1].Groups[1].Value      # 取最后一个（最新的）
}

function Get-DshState {
    $webUp = (Get-Listeners $dshPort) | Where-Object { $_.LocalAddress -eq '127.0.0.1' }
    $doorUp = (Get-Listeners $dshPort) | Where-Object { $_.LocalAddress -ne '127.0.0.1' }
    $otherPort = Get-DshWebPort -Preferred 0
    [pscustomobject]@{
        WebUp     = [bool]$webUp
        DoorUp    = @($doorUp).Count -gt 0
        OtherPort = $otherPort
        Token     = Get-DshToken
    }
}

function Show-Urls {
    param($Token)
    $ts = Get-TailscaleInfo -TailscaleExe 'C:\Program Files\Tailscale\tailscale.exe'
    $tsIp = $ts.Ip
    $lan = $null
    try {
        $lan = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -match 'WLAN|Wi-Fi|以太网|Ethernet' } |
            Select-Object -First 1).IPAddress
    } catch { }

    $key = ''
    try { $key = (Get-Content -LiteralPath $keyFile -Raw).Trim() } catch { }

    Write-Host ''
    Say '  ── 手机入口（长期有效，推荐收藏）──────────────────' 'Cyan'
    if ($tsIp -and $key) { Say ('      http://' + $tsIp + ':' + $dshPort + '/go?k=' + $key) 'White' }
    if ($lan -and $key) { Say ('      http://' + $lan + ':' + $dshPort + '/go?k=' + $key) 'White' }

    if ($Token) {
        Write-Host ''
        Say '  ── 当前令牌直连（本机浏览器用）────────────────────' 'Cyan'
        Say ('      http://127.0.0.1:' + $dshPort + '/?token=' + $Token) 'DarkGray'
    }
    Write-Host ''
}

if ($Status) {
    $st = Get-DshState
    Write-Host ''
    Say '  DSH 对话控制台状态' 'Cyan'
    Say ('    dsh web (127.0.0.1:' + $dshPort + ')   ' + $(if ($st.WebUp) { '运行中' } else { '未运行' })) $(if ($st.WebUp) { 'Green' } else { 'DarkGray' })
    Say ('    门 (tailnet:' + $dshPort + ')           ' + $(if ($st.DoorUp) { '运行中' } else { '未运行' })) $(if ($st.DoorUp) { 'Green' } else { 'DarkGray' })
    if ($st.OtherPort -gt 0 -and $st.OtherPort -ne $dshPort) {
        Say ('    另外检测到 DSH 网页在 127.0.0.1:' + $st.OtherPort + '（桌面版，本工具不使用它）') 'DarkGray'
    }
    Say ('    令牌: ' + $(if ($st.Token) { '有（可登录）' } else { '没有' })) 'DarkGray'
    if ($st.WebUp -and $st.DoorUp) { Show-Urls -Token $st.Token }
    if (-not $NoPause) { $null = Read-Host '按回车关闭' }
    exit 0
}

if ($Stop) {
    Write-Host ''
    Say '  关闭 DSH 对话控制台（把 CPU 还给抓屏）…' 'Cyan'
    $n = 0
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'tunnel-proxy\.mjs' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $n++ } catch { } }
    # 精确关掉监听 127.0.0.1:$dshPort 的那个进程（就是我们自己起的 dsh web），
    # 绝不按进程名杀 —— 桌面版 DSH 也在用同一个可执行文件名，误杀会把宿主一起带走。
    $ownerPids = @(Get-NetTCPConnection -State Listen -LocalPort $dshPort -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq '127.0.0.1' } | ForEach-Object { $_.OwningProcess } | Select-Object -Unique)
    foreach ($procId in $ownerPids) {
        if (-not $procId) { continue }
        try { Stop-Process -Id $procId -Force -ErrorAction Stop; $n++ } catch { }
    }
    Write-Host ''
    Ok ('已关闭 ' + $n + ' 个进程')
    Say '  画面帧率会回到 24 左右（如果之前掉了）。' 'Gray'
    Write-Host ''
    if (-not $NoPause) { $null = Read-Host '按回车关闭' }
    exit 0
}

# ---------------- 启动 ----------------
Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Say '  DSH 对话控制台 · 启动' 'Cyan'
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''

$st = Get-DshState
if ($st.WebUp -and $st.DoorUp -and $st.Token) {
    Ok '已经在运行'
    Show-Urls -Token $st.Token
    if (-not $NoPause) { $null = Read-Host '按回车关闭' }
    exit 0
}

$isAdmin = $false
try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $isAdmin = (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }

# 1) 启动 dsh web（写 web-lan.log，令牌从那里来）
if (-not $st.WebUp) {
    $cli = $null
    try { $cli = (Get-Command dsh.cmd -ErrorAction SilentlyContinue).Source } catch { }
    if (-not $cli) { foreach ($p in @('D:\deepseek\dsh.cmd', (Join-Path $env:USERPROFILE 'AppData\Local\Programs\dsh\dsh.cmd'))) { if (Test-Path $p) { $cli = $p; break } } }
    if (-not $cli) {
        Warn '找不到 dsh.cmd。请把 DSH 加入 PATH，或在 product.config.json 的 runtime.dshPath 填完整路径。'
        if (-not $NoPause) { $null = Read-Host '按回车关闭' }
        exit 1
    }
    Say ('  启动 dsh web（127.0.0.1:' + $dshPort + '）…') 'Gray'
    try { Remove-Item -LiteralPath $log -ErrorAction SilentlyContinue } catch { }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = '/c ""' + $cli + '" --profile web --host 127.0.0.1 --port ' + $dshPort + ' --no-open > "' + $log + '" 2>&1"'
    $psi.WorkingDirectory = $inst
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    [void][System.Diagnostics.Process]::Start($psi)

    for ($i = 0; $i -lt 45; $i++) {
        Start-Sleep -Seconds 2
        if ((Get-Listeners $dshPort) | Where-Object { $_.LocalAddress -eq '127.0.0.1' }) { break }
    }
    if (-not ((Get-Listeners $dshPort) | Where-Object { $_.LocalAddress -eq '127.0.0.1' })) {
        Warn 'dsh web 没起来。最近日志：'
        Get-Content $log -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { Say ('      ' + $_) 'DarkGray' }
        if (-not $NoPause) { $null = Read-Host '按回车关闭' }
        exit 1
    }
    Ok 'dsh web 已启动'
}

# 2) 等令牌出现
$tok = $null
for ($i = 0; $i -lt 20; $i++) { $tok = Get-DshToken; if ($tok) { break }; Start-Sleep -Seconds 1 }
if ($tok) { Ok '已取得登录令牌' } else { Warn '暂时没拿到令牌，/go 可能返回 503（等几秒再跑一次这个程序）' }

# 3) 启动三扇门
$proxy = Join-Path $inst 'tunnel-proxy.mjs'
if (-not (Test-Path $proxy)) { Warn '找不到 tunnel-proxy.mjs'; exit 1 }
$ts = Get-TailscaleInfo -TailscaleExe 'C:\Program Files\Tailscale\tailscale.exe'
$tsIp = $ts.Ip
$lan = $null
try {
    $lan = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -match 'WLAN|Wi-Fi|以太网|Ethernet' } |
        Select-Object -First 1).IPAddress
} catch { }

function Start-Door([string]$host_, [int]$port_, [string]$name) {
    if ((Get-Listeners $port_) | Where-Object { $_.LocalAddress -eq $host_ }) { Ok ('门已在监听 ' + $host_ + ':' + $port_); return }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $psi.Arguments = '"' + $proxy + '" ' + $host_ + ' ' + $port_ + ' 127.0.0.1 ' + $dshPort
    $psi.WorkingDirectory = $inst
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    [void][System.Diagnostics.Process]::Start($psi)
    Start-Sleep -Milliseconds 900
    if ((Get-Listeners $port_) | Where-Object { $_.LocalAddress -eq $host_ }) { Ok ($name + ' 门已启动 ' + $host_ + ':' + $port_) }
    else { Warn ($name + ' 门没起来') }
}

Say '  启动门…' 'Gray'
if ($tsIp) { Start-Door $tsIp $dshPort 'tailip' }
if ($lan) { Start-Door $lan $dshPort 'lan' }
Start-Door '127.0.0.1' $tailPort 'tailnet'

# 4) tailscale serve（可选，手机用域名访问）
if ($tsIp -and $ts.DnsName) { try { & 'C:\Program Files\Tailscale\tailscale.exe' serve --bg --http=80 ('http://127.0.0.1:' + $tailPort) 2>&1 | Out-Null } catch { } }

$tok2 = Get-DshToken
Show-Urls -Token $tok2
Say '  ⚠ 注意：dsh web 会占用一部分 CPU，画面帧率可能下降。' 'Yellow'
Say '     用完请运行同一个程序加 -Stop，或者双击「关闭DSH」把 CPU 还给抓屏。' 'Yellow'
Write-Host ''
if (-not $NoPause) { $null = Read-Host '按回车关闭' }
exit 0
