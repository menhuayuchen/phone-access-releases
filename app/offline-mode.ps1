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

# 2) 重启画面服务（守护进程会在约 10 秒内重新拉起）
$killed = 0
try {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'screen-server\.mjs' })
    foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch { } }
} catch { }
Write-Host ('[i] 正在重启画面服务（停掉 ' + $killed + ' 个进程，等它重新监听）…') -ForegroundColor Cyan

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
$hit = ''
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 800
    try {
        $l = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
            Where-Object { $ips -contains $_.LocalAddress })
        if ($l.Count -gt 0) { $hit = $l[0].LocalAddress; break }
    } catch { }
}

if (-not $hit) {
    Write-Host '[x] 等了约 48 秒，画面服务还没在局域网地址上监听。' -ForegroundColor Red
    Write-Host '    先双击桌面「手机远程」文件夹里的「自查」看服务状态；或点「重启」再试。' -ForegroundColor Yellow
    exit 1
}

$url = 'https://' + $hit + ':' + $port + '/?k=' + $key
Write-Host ''
Write-Host '手机直连地址（手机连同一个 Wi-Fi / 电脑热点后打开）：' -ForegroundColor Green
Write-Host ('  ' + $url) -ForegroundColor Green
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
