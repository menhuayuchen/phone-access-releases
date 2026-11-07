param(
    [ValidateSet('on', 'off')]
    [string]$Action = 'on'
)
# 离线模式的防火墙：默认安装时「拒绝局域网私有网段」的规则会挡住手机（局域网/热点/USB 直连）。
#   -Action on  ：停用**所有**产品相关的局域网拒绝规则（含旧版命名）、放行产品端口与 WebRTC UDP
#   -Action off ：恢复之前停用的拒绝规则、删除放行规则
# 历史坑：旧安装器的规则名是「DSH phone access : block lan 8660」，新版是「轻屏 : 拒绝局域网 8660」；
# 只按新版名字处理会漏掉旧规则 —— 用户手机连 8660 一直超时就是这么来的。
# 需要管理员权限（安装器/离线入口会用 Start-Process -Verb RunAs 调用）。
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'product-config.ps1')
$cfg = Get-ProductConfig -AppDir $here
$basePort = [int]$cfg.ports.screen
$ports = @($basePort, ($basePort + 1))   # +1 = 局域网 http 备用
$tag = 'PhoneAccess 轻屏'
$lanRanges = @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')
$statePath = Join-Path $here 'offline-firewall.state.json'

function Get-ProductLanBlockRules {
    $out = @()
    try {
        # 2026-11-07：除了按名字，再按**端口**兜底匹配。安装器/旧版本可能用不同命名，
        # 名字没命中就会漏掉，局域网端口一直被挡（实测踩过：
        # 「PhoneAccess 轻屏 : 拒绝局域网 8660」明明在，却没被关掉）。
        $portPat = '(' + (($ports | ForEach-Object { [string]$_ }) -join '|') + ')'
        $rules = Get-NetFirewallRule -Direction Inbound -Action Block -ErrorAction SilentlyContinue | Where-Object {
            ((($_.DisplayName -match 'phone ?access|轻屏') -and ($_.DisplayName -match 'lan|局域网|block')) -or ($_.DisplayName -match $portPat))
        }
        foreach ($r in $rules) {
            $pf = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $r -ErrorAction SilentlyContinue
            $portsOfRule = @()
            if ($pf) { $portsOfRule = @($pf.LocalPort) }
            if ($portsOfRule.Count -eq 0) { continue }
            foreach ($p in $ports) {
                if ($portsOfRule -contains [string]$p) {
                    $out += $r
                    break
                }
            }
        }
    } catch { }
    return $out
}

if ($Action -eq 'on') {
    # 1) 停用所有产品相关的"拒绝局域网"规则，并记下来以便恢复
    $disabledNames = @()
    foreach ($r in (Get-ProductLanBlockRules)) {
        if ($r.Enabled -eq 'True') {
            Set-NetFirewallRule -Name $r.Name -Enabled False -ErrorAction SilentlyContinue
            $disabledNames += $r.Name
        }
    }
    if ($disabledNames.Count -gt 0) {
        try { [System.IO.File]::WriteAllText($statePath, (ConvertTo-Json @{ disabled = $disabledNames } -Compress), (New-Object System.Text.UTF8Encoding($false))) } catch { }
    }

    # 2) 放行产品端口（TCP）来自私有网段。2026-11-07 安全加固：**限定程序**为产品自带的
    # node.exe——否则任何程序只要监听 8660/8661，局域网就能直接连进来。
    $nodeExe = Join-Path $here 'runtime\node.exe'
    foreach ($p in $ports) {
        $allowLanName = $tag + ' : 离线模式允许局域网 ' + [string]$p
        Get-NetFirewallRule -DisplayName $allowLanName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $nodeExe) {
            $null = New-NetFirewallRule -DisplayName $allowLanName -Direction Inbound -Action Allow -Protocol TCP `
                -LocalPort $p -RemoteAddress $lanRanges -Program $nodeExe -Profile Any -ErrorAction SilentlyContinue `
                -Description '轻屏：离线模式放行局域网/热点/USB 直连（仅产品 node.exe）'
        }
    }

    # 3) WebRTC 媒体（UDP 动态端口）按程序放行
    $exe = Join-Path $here 'rtc-h264\rtc-h264.exe'
    $progName = $tag + ' : 离线模式允许局域网 WebRTC'
    Get-NetFirewallRule -DisplayName $progName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $exe) {
        $null = New-NetFirewallRule -DisplayName $progName -Direction Inbound -Action Allow -Protocol UDP `
            -Program $exe -RemoteAddress $lanRanges -Profile Any -ErrorAction SilentlyContinue `
            -Description '轻屏：离线模式 WebRTC H.264 媒体（UDP）'
    }

    # 4) 串流游戏（Sunshine / Moonlight）：默认规则只放行 tailnet + 回环，局域网连不上。
    #    同一 Wi-Fi 想用手游串流，就必须把 Sunshine 的端口对私有网段放行（2026-11-07 实测：
    #    面板里写「在家里/同一 Wi-Fi」的 10.x 地址，手机一直提示"查找不到电脑"，而 tailnet 地址可用，
    #    原因就是这条规则缺局域网段）。
    # 2026-11-07 安全加固：
    #   · **不放 47990**（Sunshine 的 Web 管理界面，Moonlight 用不到；放开等于把管理后台暴露给同网段）；
    #   · 能认出 Sunshine 的 exe 时把规则**限定到该程序**，避免"端口放开但被别的程序占用"。
    $sunTcp = @(47984, 47989, 48010)                # HTTPS 配对 / HTTP 配对 / RTSP
    $sunUdp = @(47998, 47999, 48000, 48002, 48010)  # 视频 / 音频 / 控制
    # 注意：服务登记的 PathName 是 tools\sunshinesvc.exe（外壳），真正监听 47984/47989 的是
    # sunshine.exe。按服务路径限定程序会把规则绑到错误的 exe 上，局域网照样连不上。
    $sunExe = ''
    try { $pr = Get-Process -Name 'sunshine' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($pr -and $pr.Path) { $sunExe = $pr.Path } } catch { }
    if (-not $sunExe) { foreach ($c in @((Join-Path $env:ProgramFiles 'Sunshine\sunshine.exe'), (Join-Path ${env:ProgramFiles(x86)} 'Sunshine\sunshine.exe'))) { if ($c -and (Test-Path -LiteralPath $c)) { $sunExe = $c; break } } }
    if ($sunExe -and -not (Test-Path -LiteralPath $sunExe)) { $sunExe = '' }
    foreach ($proto in @('TCP', 'UDP')) {
        $list = if ($proto -eq 'TCP') { $sunTcp } else { $sunUdp }
        $name = $tag + ' : 离线模式允许局域网串流 ' + $proto
        Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
        if ($sunExe) {
            foreach ($p in $list) {
                $null = New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol $proto `
                    -LocalPort $p -RemoteAddress $lanRanges -Program $sunExe -Profile Any -ErrorAction SilentlyContinue `
                    -Description '轻屏：离线模式下允许局域网 Moonlight 串流（仅 Sunshine 程序）'
            }
        }
    }
    # 顺带清掉历史版本留下的 47990（当时放得太宽）
    foreach ($old in @(Get-NetFirewallRule -DisplayName ($tag + ' : 离线模式允许局域网串流 TCP') -ErrorAction SilentlyContinue)) {
        $pf = $old | Get-NetFirewallPortFilter
        if (@($pf.LocalPort) -contains '47990') { Remove-NetFirewallRule -Name $old.Name -ErrorAction SilentlyContinue }
    }
} else {
    # 关：删放行规则、恢复之前停用的拒绝规则
    foreach ($p in $ports) {
        Get-NetFirewallRule -DisplayName ($tag + ' : 离线模式允许局域网 ' + [string]$p) -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    }
    Get-NetFirewallRule -DisplayName ($tag + ' : 离线模式允许局域网 WebRTC') -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    Get-NetFirewallRule -DisplayName ($tag + ' : 离线模式允许局域网串流 TCP') -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    Get-NetFirewallRule -DisplayName ($tag + ' : 离线模式允许局域网串流 UDP') -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $statePath) {
        try {
            $st = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($n in @($st.disabled)) {
                if ($n) { Enable-NetFirewallRule -Name $n -ErrorAction SilentlyContinue }
            }
        } catch { }
        try { Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue } catch { }
    }
}

# 验证：离线模式下，产品端口应有一条 Allow 规则、且没有启用的局域网 Block 规则
$okAllow = $false
try { $okAllow = [bool](Get-NetFirewallRule -DisplayName ($tag + ' : 离线模式允许局域网 ' + [string]$basePort) -ErrorAction SilentlyContinue) } catch { }
$stillBlocked = @(Get-ProductLanBlockRules | Where-Object { $_.Enabled -eq 'True' })
$stillNames = @($stillBlocked | ForEach-Object { $_.DisplayName })
if ($Action -eq 'on' -and (-not $okAllow -or $stillBlocked.Count -gt 0)) {
    $errText = '需要管理员权限或被安全策略锁定（还启用的拒绝规则：' + ($stillNames -join '; ') + '）'
    Write-Output (ConvertTo-Json @{ ok = $false; error = $errText } -Compress)
    exit 1
}
Write-Output (ConvertTo-Json @{ ok = $true; action = $Action; disabledRules = @($disabledNames).Count } -Compress)
