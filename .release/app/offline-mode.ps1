# 离线模式（没有互联网 / 没有 Tailscale）：一键开局域网访问并打开手机直连地址。
# 做的事：打开 screen.offline 开关 -> 重启画面服务（守护会自动拉起）-> 等局域网 https 端口起来
#         -> 用默认浏览器打开 https://<局域网IP>:8660/?k=KEY
# 局域网是自签证书：手机第一次会提示「不安全」，点「高级 → 继续前往」即可。
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgPath = Join-Path $here 'product.config.json'
$port = 8660
$key = ''

try {
    $j = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($j.ports -and $j.ports.screen) { $port = [int]$j.ports.screen }
} catch { }
try { $key = (Get-Content -LiteralPath (Join-Path $here 'screen.key') -Raw -ErrorAction Stop).Trim() } catch { }

# 1) 打开离线模式开关
try {
    $j = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if (-not $j.PSObject.Properties['screen']) { $j | Add-Member -NotePropertyName screen -NotePropertyValue (New-Object psobject) -Force }
    if ($j.screen.PSObject.Properties['offline']) { $j.screen.offline = $true }
    else { $j.screen | Add-Member -NotePropertyName offline -NotePropertyValue $true -Force }
    [System.IO.File]::WriteAllText($cfgPath, ($j | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host '[i] 已开启「离线模式」（局域网监听：https + WebRTC）' -ForegroundColor Cyan
} catch {
    Write-Host ('[!] 写配置失败：' + $_.Exception.Message) -ForegroundColor Yellow
}

# 1.5) 防火墙：放行局域网/热点/USB 直连（需要管理员，会弹一次 UAC）
$fw = Join-Path $here 'offline-firewall.ps1'
if (Test-Path -LiteralPath $fw) {
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Write-Host '[i] 正在放行局域网端口（会弹一次管理员授权，请点「是」）…' -ForegroundColor Cyan
    $fwProc = $null
    try {
        $fwProc = Start-Process -FilePath $psExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $fw, '-Action', 'on') -Verb RunAs -PassThru -WindowStyle Hidden
    } catch {
        Write-Host '[!] 放行失败（没点授权/不是管理员）：手机可能连不上，可以稍后手动点「重启」再试' -ForegroundColor Yellow
    }
    # 别无限等 UAC：最多等 30 秒，人不在电脑前也不至于卡死（防火墙规则是幂等的，之后再开也行）
    if ($fwProc) {
        for ($i = 0; $i -lt 60 -and -not $fwProc.HasExited; $i++) { Start-Sleep -Milliseconds 500 }
        if (-not $fwProc.HasExited) { Write-Host '[i] 管理员授权还没点，防火墙放行先跳过（不影响局域网监听）' -ForegroundColor Yellow }
    }
}

# 2) 重启画面服务
#    坑（2026-11-06 实测）：服务是以管理员权限由守护进程拉起的，普通权限 Stop-Process 杀不掉（会抛异常被吞），
#    结果脚本傻等 48 秒后报"还没在局域网地址上监听"—— 用户看到的就是「卡在重启画面服务」。
#    正确做法：POST /offline/on 让服务自己写配置并退出，守护进程会在 10 秒内按新配置重新拉起。
$restarted = $false
try {
    $body = [System.Text.Encoding]::UTF8.GetBytes('{}')
    $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/offline/on?k=' + [uri]::EscapeDataString($key)) `
        -Method POST -Body $body -ContentType 'application/json' -TimeoutSec 8 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $restarted = $true }
} catch { }
if (-not $restarted) {
    # 服务没在跑（或没有密钥）：直接拉起整套服务更省事
    Write-Host '[i] 画面服务当前没响应，改为直接启动…' -ForegroundColor Yellow
    $starter = Join-Path $here 'start-phone-access.ps1'
    if (Test-Path -LiteralPath $starter) {
        try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $starter -Quiet | Out-Null } catch { }
    } else {
        try { Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('"' + (Join-Path $here 'start-screen.cmd') + '"')) -WindowStyle Hidden } catch { }
    }
} else {
    Write-Host '[i] 已让画面服务按「离线模式」重启（守护进程会自动拉起，约 10 秒）…' -ForegroundColor Cyan
}

# 3) 等局域网地址上的端口起来
# 跳过虚拟网卡（VMware/Hyper-V 等）：它们的 IP 手机根本连不到，会让二维码/地址指错
$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
        $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' -and
        $_.InterfaceAlias -notmatch 'VMware|vEthernet|VirtualBox|Loopback|Tailscale|WSL|Bluetooth'
    } |
    Select-Object -ExpandProperty IPAddress -Unique)
# 有默认网关的那块网卡优先（Wi-Fi/以太网），别把虚拟机网段排前面
$defaultIps = @()
try {
    $gwIfs = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty InterfaceAlias -Unique)
    $defaultIps = @($ips | Where-Object {
        $ip = $_
        $a = @(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $ip -ErrorAction SilentlyContinue | Select-Object -First 1)
        return ($a -and $gwIfs -contains $a.InterfaceAlias)
    })
} catch { }
if ($defaultIps.Count -gt 0) { $ips = $defaultIps + @($ips | Where-Object { $defaultIps -notcontains $_ }) }
# USB 网络共享（RNDIS）最快：有就排最前面
$usbIps = @()
try {
    $usbIps = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'RNDIS|Remote NDIS|USB' } | ForEach-Object { (Get-NetIPAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).IPAddress } | Where-Object { $_ })
} catch { }
if ($usbIps.Count -gt 0) { $ips = @($usbIps) + @($ips | Where-Object { $usbIps -notcontains $_ }) }
$hit = ''
$lanHttps = $null
for ($i = 0; $i -lt 75; $i++) {
    Start-Sleep -Milliseconds 800
    try {
        $l = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
            Where-Object { $ips -contains $_.LocalAddress })
        if ($l.Count -gt 0) { $hit = $l[0].LocalAddress; break }
    } catch { }
    # 每 8 轮问一次服务的真实状态（offline 配置文件 ≠ 进程状态，必须问进程）
    if ($i -gt 0 -and ($i % 10) -eq 0) {
        try {
            $j = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
            $p2 = if ($j.ports -and $j.ports.screen) { [int]$j.ports.screen } else { $port }
            $info = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $p2 + '/offline-info?k=' + [uri]::EscapeDataString($key)) -TimeoutSec 5
            $lanHttps = [bool]$info.https
        } catch { }
    }
}

if (-not $hit) {
    Write-Host '[x] 等了约 60 秒，画面服务还没在局域网地址上监听。' -ForegroundColor Red
    # 分清两种原因，别让用户猜
    $cfgOffline = $null
    try { $j = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json; $cfgOffline = [bool]$j.screen.offline } catch { }
    if ($cfgOffline -and $lanHttps -eq $false) {
        Write-Host '    原因：配置里的离线模式已经是开的，但正在跑的服务还是按「非离线」起的（说明它没被重启成功）。' -ForegroundColor Yellow
        Write-Host '    办法：再双击一次本脚本；还不行就双击同目录的「重启」，然后再双击本脚本。' -ForegroundColor Yellow
    } elseif ($lanHttps -eq $true) {
        Write-Host '    原因：服务已经在离线模式了，但这台电脑的局域网地址对不上（可能刚换了网络）。' -ForegroundColor Yellow
        Write-Host ('    现在服务监听的地址：' + ((Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq $port } | Select-Object -ExpandProperty LocalAddress -Unique) -join ', ')) -ForegroundColor DarkGray
        Write-Host '    办法：等几秒再运行一次本脚本（局域网地址变了服务会自动重启）。' -ForegroundColor Yellow
    } else {
        Write-Host '    原因：画面服务没起来（可能被别的程序占用了端口）。' -ForegroundColor Yellow
        Write-Host '    办法：双击桌面「自查」看报告，或点「重启」。' -ForegroundColor Yellow
    }
    exit 1
}

$url = 'https://' + $hit + ':' + $port + '/?k=' + $key
$urlAlt = 'https://' + $hit + ':' + ($port + 2) + '/?k=' + $key
$urlHttp = 'http://' + $hit + ':' + ($port + 1) + '/?k=' + $key
Write-Host ''
Write-Host '手机直连地址（手机连同一个 Wi-Fi / 电脑热点后打开）：' -ForegroundColor Green
Write-Host ('  ' + $url) -ForegroundColor Green
Write-Host ('  一直超时/打不开时用备用端口：' + $urlAlt) -ForegroundColor DarkGray
Write-Host ('  证书页过不去用明文备用：' + $urlHttp) -ForegroundColor DarkGray
Write-Host ''
Write-Host '提示：' -ForegroundColor Cyan
Write-Host '  · 手机第一次打开会提示"连接不是私密连接" —— 点「高级 → 继续前往」即可（自签证书）。'
Write-Host '  · 电脑热点默认 SSID：PhoneAccess-Offline，密码：phoneaccess（在设置 → 离线模式里开关）。'
Write-Host '  · 页面 HUD 显示「WebRTC264 直连」才是低延迟通道；显示 WS 说明没走 https。'
Write-Host '  · 想关掉局域网访问：设置 → 离线模式 → 取消勾选。'
Write-Host ''

try {
    Start-Process $url | Out-Null
    Write-Host '[i] 已用默认浏览器打开上面的地址（电脑本机）。' -ForegroundColor Cyan
} catch {
    Write-Host ('[!] 打开浏览器失败：' + $_.Exception.Message) -ForegroundColor Yellow
}
