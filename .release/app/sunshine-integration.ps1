<#
.SYNOPSIS
    高性能模式（Moonlight / Sunshine）的安装、卸载与状态检查 —— 产品侧脚本

.DESCRIPTION
    为什么要有这个脚本：
      Moonlight 客户端延迟低、体验好，但客户要自己装 Sunshine 并配置一天——这是劝退点。
      我们的做法：安装包顺带把 Sunshine 装好并预配置（只绑 Tailscale、自动设随机凭据、
      防火墙收紧到 tailnet、卸载时清理干净），客户只需要在手机上装 Moonlight 并输入 PIN。

    设计约束（2026-11-03 用户在 VMware 里实测确认的六条路径）：
      · `msiexec /i ... /qn` 静默装可用，服务名 SunshineService；
      · 服务起来后要 15–20 秒 Web UI 才可用 → 必须**轮询** /api/config，不能固定 sleep；
      · 未设凭据时 POST /api/password（无认证）可以设凭据 → 生成随机密码并落盘；
      · MSI 会加两条 Inbound Allow 规则（名 "Sunshine"，TCP+UDP，remote=Any）→ 必须收紧到 tailnet+回环；
      · 卸载只清服务和规则，`%ProgramFiles%\Sunshine\config` 会残留 → 必须显式删；
      · GPL-3.0：以独立程序分发，不改源码；发布时附许可证文本和上游源码链接。

.NOTES
    UTF-8 with BOM，Windows PowerShell 5.1。
    这个脚本不负责下载 MSI：MSI 随包放在同目录（或 -MsiPath 指定），没装过时才用得到。
#>
[CmdletBinding()]
param(
    [ValidateSet('status', 'install', 'credentials', 'uninstall')]
    [string]$Action = 'status',
    # 产品安装目录（默认 = 脚本所在目录）；凭据/marker 都写在这里
    [string]$AppDir = '',
    # Sunshine MSI 路径；默认找同目录的 Sunshine-Windows-AMD64-installer.msi
    [string]$MsiPath = '',
    # 要绑定的 tailnet IP；不填就自动取 `tailscale ip -4` 的第一个 100.x，取不到退回 127.0.0.1
    [string]$TailnetIp = '',
    [int]$Port = 47989,
    [string]$SunshineName = '轻屏-高性能',
    [switch]$Json,
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $AppDir) { $AppDir = $here }
$markerFile = Join-Path $AppDir 'sunshine-integration.json'
$credFile = Join-Path $AppDir 'sunshine-credentials.json'
$sunshineDir = Join-Path $env:ProgramFiles 'Sunshine'
$sunshineExe = Join-Path $sunshineDir 'sunshine.exe'
$confDir = Join-Path $sunshineDir 'config'
$confFile = Join-Path $confDir 'sunshine.conf'
$svcName = 'SunshineService'
$tailnetRanges = @('100.64.0.0/10', '127.0.0.1')

function Say([string]$m, [string]$color = 'Gray') { if (-not $Quiet) { Write-Host $m -ForegroundColor $color } }
function Fail([string]$m) { if ($Json) { [pscustomobject]@{ ok = $false; action = $Action; error = $m } | ConvertTo-Json -Depth 6 } else { Say ('[x] ' + $m) 'Red' }; exit 1 }

function Get-TailscaleIp {
    if ($TailnetIp) { return $TailnetIp }
    $candidates = @()
    try {
        $ts = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
        if (-not (Test-Path $ts)) { $ts = (Get-Command tailscale.exe -ErrorAction SilentlyContinue).Source }
        if ($ts) {
            $out = & $ts ip -4 2>$null
            foreach ($line in @($out)) { if ($line -match '^100\.(\d+)\.') { $candidates += $line.Trim() } }
        }
    } catch { }
    if ($candidates.Count -gt 0) { return $candidates[0] }
    return '127.0.0.1'
}

function Get-SunshineInstalled {
    $installed = Test-Path -LiteralPath $sunshineExe
    $productCode = ''
    try {
        $keys = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
        $app = Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^Sunshine' } | Select-Object -First 1
        if ($app) { $productCode = [string]$app.PSChildName }
    } catch { }
    return [pscustomobject]@{ installed = $installed; exe = $sunshineExe; productCode = $productCode }
}

function Get-SunshineHost {
    <#
      Sunshine 实际绑在哪个地址：以 sunshine.conf 的 bind_address 为准（我们写的是 tailnet IP）。
      为什么不能写死 127.0.0.1：绑定 tailnet IP 后它**不再监听回环**，
      本地代理必须走同一个 tailnet 地址，否则 /api/* 全部 403/连不上（2026-11-03 真机踩到）。
    #>
    try {
        if (Test-Path -LiteralPath $confFile) {
            $raw = Get-Content -LiteralPath $confFile -Raw -Encoding UTF8
            $m = [regex]::Match($raw, '(?m)^\s*bind_address\s*=\s*(\S+)\s*$')
            if ($m.Success) {
                $h = $m.Groups[1].Value.Trim()
                if ($h -match '^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d+\.\d+$') { return $h }
                if ($h -eq '127.0.0.1' -or $h -eq 'localhost') { return '127.0.0.1' }
                # 0.0.0.0 / 其他：按本机回环试
                return '127.0.0.1'
            }
        }
    } catch { }
    return '127.0.0.1'
}

function Get-SunshineService {
    try { return Get-Service -Name $svcName -ErrorAction Stop } catch { return $null }
}

function Test-WebUp {
    # 用 TCP 连 47990 判断 Web UI 是否已起来（比 HTTP 更便宜，且不受欢迎页/证书影响）
    $h = Get-SunshineHost
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($h, 47990, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(800)) { try { $client.Close() } catch { }; return $false }
        $client.EndConnect($iar)
        $client.Close()
        return $true
    } catch { return $false }
}

function Wait-WebUp([int]$timeoutSec = 60) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-WebUp) { return $true }
        Start-Sleep -Milliseconds 800
    }
    return $false
}

# 忽略自签证书（只连本机 127.0.0.1:47990）
try {
    Add-Type @"
using System.Net;using System.Security.Cryptography.X509Certificates;
public class SunshineTrustAll : ICertificatePolicy {
  public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) { return true; }
}
"@
    [System.Net.ServicePointManager]::CertificatePolicy = New-Object SunshineTrustAll
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
} catch { }

function Invoke-SunshineApi {
    param([string]$Method = 'GET', [string]$Path = '/api/config', $Body = $null, [string]$User = '', [string]$Pass = '')
    $headers = @{}
    if ($User) { $headers['Authorization'] = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($User + ':' + $Pass)) }
    # 目标地址跟着 sunshine.conf 的 bind_address 走（tailnet IP 或回环），见 Get-SunshineHost
    $reqArgs = @{ Uri = ('https://' + (Get-SunshineHost) + ':47990' + $Path); Method = $Method; Headers = $headers; UseBasicParsing = $true; TimeoutSec = 15 }
    if ($null -ne $Body) {
        $json = ($Body | ConvertTo-Json -Compress)
        $reqArgs['ContentType'] = 'application/json'
        $reqArgs['Body'] = [Text.Encoding]::UTF8.GetBytes($json)
    }
    try {
        $r = Invoke-WebRequest @reqArgs
        return [pscustomobject]@{ ok = $true; status = [int]$r.StatusCode; content = $r.Content }
    } catch {
        $code = 0
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        return [pscustomobject]@{ ok = $false; status = $code; content = ''; error = $_.Exception.Message }
    }
}

function Read-Creds {
    try {
        if (-not (Test-Path -LiteralPath $credFile)) { return $null }
        $j = Get-Content -LiteralPath $credFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($j -and $j.username -and $j.password) { return $j }
    } catch { }
    return $null
}

function New-RandomPassword {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%'
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $sb = New-Object System.Text.StringBuilder
    foreach ($b in $bytes) { [void]$sb.Append($chars[$b % $chars.Length]) }
    return $sb.ToString()
}

function Save-Creds([string]$user, [string]$pass) {
    $obj = [pscustomobject]@{ username = $user; password = $pass; setAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') }
    try {
        [System.IO.File]::WriteAllText($credFile, ($obj | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
        # 尽力收紧 ACL：只允许当前用户和管理员读
        try {
            $acl = Get-Acl -LiteralPath $credFile
            $acl.SetAccessRuleProtection($true, $false)
            $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
            $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
            $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('BUILTIN\Administrators', 'FullControl', 'Allow')))
            Set-Acl -LiteralPath $credFile -AclObject $acl
        } catch { }
        return $true
    } catch { return $false }
}

function Set-CredentialsIfNeeded {
    $creds = Read-Creds
    if ($creds) {
        # 已有凭据：验证能用；能用就跳过
        $r = Invoke-SunshineApi -Path '/api/config' -User $creds.username -Pass $creds.password
        if ($r.ok) { return [pscustomobject]@{ ok = $true; action = 'reuse'; user = $creds.username } }
    }
    # 无凭据（或旧凭据失效）：Sunshine 首次运行允许无认证改密码
    $user = 'pahost'
    $pass = New-RandomPassword
    $body = @{ currentUsername = ''; currentPassword = ''; newUsername = $user; newPassword = $pass; confirmNewPassword = $pass }
    $r = Invoke-SunshineApi -Method 'POST' -Path '/api/password' -Body $body
    if (-not $r.ok) {
        # 兜底：Sunshine 里已经有凭据、但我们的凭据文件丢了（例如重跑验证/清过临时目录）。
        # 这时无认证改密码会被拒（401）——把 state 文件移走再重启服务，Sunshine 就回到"首次运行"。
        # 需要管理员（服务操作），安装器/验证脚本本身就是提权跑的。
        $stateFile = Join-Path $confDir 'sunshine_state.json'
        $svc = Get-SunshineService
        if ((Test-Path -LiteralPath $stateFile) -and $svc) {
            $bak = $stateFile + '.bak-' + (Get-Date -Format 'yyyyMMddHHmmss')
            # 先停服务再移文件（服务运行时文件可能被占用），移完再启动
            try { Stop-Service -Name $svcName -Force -ErrorAction SilentlyContinue } catch { }
            Start-Sleep -Milliseconds 800
            try { Move-Item -LiteralPath $stateFile -Destination $bak -Force -ErrorAction Stop } catch { }
            try {
                Start-Service -Name $svcName -ErrorAction Stop
                [void](Wait-WebUp 60)
            } catch { }
            $r = Invoke-SunshineApi -Method 'POST' -Path '/api/password' -Body $body
            if (-not $r.ok) {
                return [pscustomobject]@{ ok = $false; error = ('重置 Sunshine 凭据失败：HTTP ' + $r.status + ' ' + $r.error + '（旧 state 备份：' + $bak + '）') }
            }
        } else {
            return [pscustomobject]@{ ok = $false; error = ('设置 Sunshine 凭据失败：HTTP ' + $r.status + ' ' + $r.error) }
        }
    }
    if (-not (Save-Creds $user $pass)) { return [pscustomobject]@{ ok = $false; error = '凭据写不进安装目录' } }
    return [pscustomobject]@{ ok = $true; action = 'created'; user = $user }
}

function Set-FirewallHardening {
    # MSI 默认加两条 Inbound Allow「Sunshine」规则（TCP+UDP、remote=Any）→ 收紧到 tailnet+回环。
    $changed = 0; $found = 0
    try {
        $rules = @(Get-NetFirewallRule -DisplayName '*Sunshine*' -ErrorAction SilentlyContinue)
        $found = $rules.Count
        foreach ($r in $rules) {
            try {
                Set-NetFirewallRule -Name $r.Name -RemoteAddress $tailnetRanges -ErrorAction Stop
                $changed++
            } catch { }
        }
    } catch { }
    return [pscustomobject]@{ found = $found; changed = $changed }
}

function Write-Conf {
    $ip = Get-TailscaleIp
    if (-not (Test-Path -LiteralPath $confDir)) { New-Item -ItemType Directory -Path $confDir -Force | Out-Null }
    $lines = @(
        'sunshine_name = ' + $SunshineName
        'bind_address = ' + $ip
        ('port = ' + $Port)
        # 绑定 tailnet IP 之后回环不再监听，本地代理走同一个 tailnet 地址；
        # 所以 Web UI 的origin 必须允许 lan（tailnet），否则 /api/* 全部 403（2026-11-03 真机踩到）。
        # 安全前提：只绑 tailnet、Web UI 有随机强密码、防火墙只放 tailnet。
        'origin_web_ui_allowed = lan'
        'upnp = disabled'
        'min_log_level = info'
        # 只广播 H.264（hevc_mode/av1_mode = 1 = 不广播）：
        # 真机实测第一次串流协商到 AV1/HEVC，手机端 30 秒后断开、重连证书身份校验失败；
        # H.264 兼容性最好，办公场景也够用（编码在 GPU 上，CPU 占用低）。
        'hevc_mode = 1'
        'av1_mode = 1'
    )
    try {
        # UTF-8 无 BOM：写 ASCII 会中文名变 ????-???（真机踩到）
        [System.IO.File]::WriteAllText($confFile, (($lines -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
        return $true
    } catch { return $false }
}

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------
if ($Action -eq 'status') {
    $inst = Get-SunshineInstalled
    $svc = Get-SunshineService
    $creds = Read-Creds
    $result = [ordered]@{
        ok            = $true
        action        = 'status'
        installed     = [bool]$inst.installed
        productCode   = [string]$inst.productCode
        serviceName   = $svcName
        serviceStatus = if ($svc) { [string]$svc.Status } else { '' }
        webUp         = (Test-WebUp)
        credentialsSet = [bool]$creds
        tailnetIp     = (Get-TailscaleIp)
        port          = $Port
        marker        = (Test-Path -LiteralPath $markerFile)
    }
    if ($Json) { [pscustomobject]$result | ConvertTo-Json -Depth 6 }
    else {
        Say ('Sunshine: installed=' + $result.installed + ' service=' + $result.serviceStatus + ' webUp=' + $result.webUp + ' creds=' + $result.credentialsSet)
        Say ('tailnetIp=' + $result.tailnetIp + ' port=' + $result.port)
    }
    exit 0
}

# ---------------------------------------------------------------------------
# credentials（只设置配对凭据；不需要管理员权限）
# ---------------------------------------------------------------------------
if ($Action -eq 'credentials') {
    if (-not (Wait-WebUp 60)) { Fail 'Sunshine Web UI 没起来（服务没启动？）' }
    $cred = Set-CredentialsIfNeeded
    if (-not $cred.ok) { Fail $cred.error }
    $result = [ordered]@{ ok = $true; action = 'credentials'; credentials = $cred.action; user = $cred.user; port = $Port }
    if ($Json) { [pscustomobject]$result | ConvertTo-Json -Depth 6 }
    else { Say ('凭据：' + $cred.action + ' user=' + $cred.user) 'Green' }
    exit 0
}

# ---------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------
if ($Action -eq 'install') {
    $inst = Get-SunshineInstalled
    $isAdmin = $false
    try { $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { }
    $warns = New-Object System.Collections.ArrayList
    if (-not $inst.installed) {
        if (-not $isAdmin) { Fail '装 Sunshine 需要管理员权限：请从页面点按钮（会弹管理员授权）' }
        if (-not $MsiPath) { $MsiPath = Join-Path $here 'Sunshine-Windows-AMD64-installer.msi' }
        if (-not (Test-Path -LiteralPath $MsiPath)) { Fail ('找不到 Sunshine 安装包：' + $MsiPath) }
        $log = Join-Path $env:TEMP 'sunshine-msi-install.log'
        Say ('安装 Sunshine（静默）：' + $MsiPath)
        $p = Start-Process msiexec.exe -ArgumentList @('/i', ('"' + $MsiPath + '"'), '/qn', '/norestart', '/l*v', ('"' + $log + '"')) -Wait -PassThru
        if ($p.ExitCode -ne 0) { Fail ('Sunshine 安装失败，msiexec exit=' + $p.ExitCode + '（日志 ' + $log + '）') }
    } else {
        Say 'Sunshine 已经装了，跳过安装，只做预配置。'
    }

    # 1) 服务/Web UI（不需要管理员）
    $svc = Get-SunshineService
    if (-not $svc) { [void]$warns.Add('找不到 SunshineService（安装可能没完成）') }
    if (-not (Wait-WebUp 60)) { Fail 'Sunshine Web UI 60 秒内没起来（看 %ProgramFiles%\Sunshine\config\sunshine.log）' }

    # 2) 凭据：先做（不需要管理员，配对就靠它；不让配置写失败把整件事卡死）
    $cred = Set-CredentialsIfNeeded
    if (-not $cred.ok) { Fail $cred.error }
    Say ('凭据：' + $cred.action + ' user=' + $cred.user)

    # 3) 预配置 + 重启服务 + 防火墙（需要管理员；失败只警告，不影响配对）
    if ($isAdmin) {
        if (-not (Write-Conf)) { [void]$warns.Add('写不了配置文件：' + $confFile) }
        else {
            $svc2 = Get-SunshineService
            if ($svc2) {
                try {
                    if ($svc2.Status -eq 'Running') { Restart-Service -Name $svcName -Force -ErrorAction Stop }
                    else { Start-Service -Name $svcName -ErrorAction Stop }
                } catch { [void]$warns.Add('重启服务失败：' + $_.Exception.Message) }
            }
            if (-not (Wait-WebUp 60)) { [void]$warns.Add('重启后 Web UI 没起来') }
        }
        try {
            $fw = Set-FirewallHardening
            Say ('防火墙：找到 ' + $fw.found + ' 条，收紧 ' + $fw.changed + ' 条')
        } catch { [void]$warns.Add('防火墙收紧失败：' + $_.Exception.Message) }
    } else {
        [void]$warns.Add('没有管理员权限：跳过"只绑 tailnet / 防火墙收紧"（配对不受影响）')
    }
    foreach ($w in $warns) { Say ('[!] ' + $w) 'Yellow' }

    $marker = [pscustomobject]@{
        installedByUs = $true
        installedAt   = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        version       = '2026.914.233613'
        port          = $Port
        exe           = $sunshineExe
    }
    try { [System.IO.File]::WriteAllText($markerFile, ($marker | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false))) } catch { }

    $result = [ordered]@{
        ok = $true; action = 'install'; installed = $true; credentials = $cred.action
        elevated = $isAdmin; warnings = @($warns); tailnetIp = (Get-TailscaleIp); port = $Port
    }
    if ($Json) { [pscustomobject]$result | ConvertTo-Json -Depth 6 }
    else { Say ('高性能模式已就绪：tailnet ' + (Get-TailscaleIp) + ':' + $Port + '，手机装 Moonlight 后配对即可。') 'Green' }
    exit 0
}

# ---------------------------------------------------------------------------
# uninstall
# ---------------------------------------------------------------------------
if ($Action -eq 'uninstall') {
    $marker = $null
    try { if (Test-Path -LiteralPath $markerFile) { $marker = Get-Content -LiteralPath $markerFile -Raw -Encoding UTF8 | ConvertFrom-Json } } catch { }
    if (-not $marker -or -not $marker.installedByUs) {
        Say 'Sunshine 不是本产品装的（或没装），不自动卸载。'
        $result = [ordered]@{ ok = $true; action = 'uninstall'; skipped = $true; reason = 'not-installed-by-us' }
        if ($Json) { [pscustomobject]$result | ConvertTo-Json -Depth 6 }
        exit 0
    }
    $inst = Get-SunshineInstalled
    if ($inst.installed -and $inst.productCode) {
        Say ('卸载 Sunshine（' + $inst.productCode + '）…')
        $p = Start-Process msiexec.exe -ArgumentList @('/x', $inst.productCode, '/qn', '/norestart') -Wait -PassThru
        Say ('msiexec /x exit=' + $p.ExitCode)
    }
    # MSI 会留下 config 目录（conf/state/日志/证书），必须删
    try { if (Test-Path -LiteralPath $confDir) { Remove-Item -LiteralPath $confDir -Recurse -Force -ErrorAction SilentlyContinue } } catch { }
    try { if (Test-Path -LiteralPath $sunshineDir) { Remove-Item -LiteralPath $sunshineDir -Recurse -Force -ErrorAction SilentlyContinue } } catch { }
    try { if (Test-Path -LiteralPath $credFile) { Remove-Item -LiteralPath $credFile -Force -ErrorAction SilentlyContinue } } catch { }
    try { if (Test-Path -LiteralPath $markerFile) { Remove-Item -LiteralPath $markerFile -Force -ErrorAction SilentlyContinue } } catch { }
    $result = [ordered]@{ ok = $true; action = 'uninstall'; removed = $true; serviceGone = (-not (Get-SunshineService)) }
    if ($Json) { [pscustomobject]$result | ConvertTo-Json -Depth 6 }
    else { Say '高性能模式已卸载（服务/防火墙规则/配置都已清理）。' 'Green' }
    exit 0
}
