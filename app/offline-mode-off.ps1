# 关闭离线模式：恢复默认（只监听回环 + Tailscale），撤销局域网/热点/USB 的防火墙放行。
# 双击后：写 screen.offline=false -> 恢复防火墙（需要一次管理员授权）-> 重启画面服务。
param(
    [switch]$DryRun
)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgPath = Join-Path $here 'product.config.json'
$port = 8660
$cur = $null
try {
    $j = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($j.ports -and $j.ports.screen) { $port = [int]$j.ports.screen }
    if ($j.screen) { $cur = $j.screen.offline }
} catch { }

if ($DryRun) {
    Write-Host ('[dry] 当前 screen.offline=' + [string]$cur + '；会把开关设为 false、恢复防火墙规则、重启画面服务。')
    exit 0
}

# 1) 关闭离线模式开关
try {
    $j = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if (-not $j.PSObject.Properties['screen']) { $j | Add-Member -NotePropertyName screen -NotePropertyValue (New-Object psobject) -Force }
    if ($j.screen.PSObject.Properties['offline']) { $j.screen.offline = $false }
    else { $j.screen | Add-Member -NotePropertyName offline -NotePropertyValue $false -Force }
    [System.IO.File]::WriteAllText($cfgPath, ($j | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host '[i] 已关闭「离线模式」开关' -ForegroundColor Cyan
} catch {
    Write-Host ('[!] 写配置失败：' + $_.Exception.Message) -ForegroundColor Yellow
}

# 2) 恢复防火墙（撤销局域网放行、恢复默认的拒绝规则；需要管理员，会弹一次 UAC）
$fw = Join-Path $here 'offline-firewall.ps1'
if (Test-Path -LiteralPath $fw) {
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Write-Host '[i] 正在恢复防火墙规则（会弹一次管理员授权，请点「是」）…' -ForegroundColor Cyan
    $fwProc = $null
    try {
        $fwProc = Start-Process -FilePath $psExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $fw, '-Action', 'off') -Verb RunAs -PassThru -WindowStyle Hidden
    } catch {
        Write-Host '[!] 防火墙恢复没完成（没点授权/不是管理员）：局域网端口可能仍处于放行状态，但不影响使用' -ForegroundColor Yellow
    }
    # 别无限等 UAC：最多 30 秒（用户可能不在电脑前）
    if ($fwProc) {
        for ($i = 0; $i -lt 60 -and -not $fwProc.HasExited; $i++) { Start-Sleep -Milliseconds 500 }
        if (-not $fwProc.HasExited) { Write-Host '[i] 管理员授权还没点，防火墙恢复先跳过（不影响关闭局域网监听）' -ForegroundColor Yellow }
    }
}

# 3) 重启画面服务，让监听地址回到 127.0.0.1 + tailnet
#    坑（同 offline-mode.ps1，2026-11-06 实测）：服务是管理员权限跑的，普通权限 Stop-Process 杀不掉，
#    会静默失败 → 局域网监听一直不撤。改成 POST /offline/off 让服务自己退出，守护进程按新配置拉起。
$restarted = $false
try {
    $key = ''
    try { $key = (Get-Content -LiteralPath (Join-Path $here 'screen.key') -Raw -ErrorAction Stop).Trim() } catch { }
    $body = [System.Text.Encoding]::UTF8.GetBytes('{}')
    $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/offline/off?k=' + [uri]::EscapeDataString($key)) `
        -Method POST -Body $body -ContentType 'application/json' -TimeoutSec 8 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $restarted = $true }
} catch { }
if ($restarted) {
    Write-Host '[i] 已让画面服务按「关闭离线模式」重启（守护进程会自动拉起，约 10 秒）…' -ForegroundColor Cyan
} else {
    Write-Host '[i] 画面服务没响应，改为直接启动…' -ForegroundColor Yellow
    $starter = Join-Path $here 'start-phone-access.ps1'
    if (Test-Path -LiteralPath $starter) { try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $starter -Quiet | Out-Null } catch { } }
}

# 4) 等回环端口恢复
$ok = $false
for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Milliseconds 800
    try {
        $l = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' })
        if ($l.Count -gt 0) { $ok = $true; break }
    } catch { }
}
Write-Host ''
if ($ok) {
    Write-Host '[✓] 离线模式已关闭：画面服务已恢复为只监听本机/Tailscale。' -ForegroundColor Green
} else {
    Write-Host '[!] 画面服务还没起来：双击「自查」看看，或点「重启」再试一次。' -ForegroundColor Yellow
}
Write-Host '    手机请改用 tailnet 地址（桌面「手机入口」里能看到），或重新打开「离线模式」。' -ForegroundColor Gray
Write-Host '    如果之前开了电脑热点，可以在 设置 → 离线模式 里手动关掉。' -ForegroundColor Gray
Write-Host ''
