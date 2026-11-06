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
    try {
        Start-Process -FilePath $psExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $fw, '-Action', 'off') -Verb RunAs -Wait -WindowStyle Hidden
    } catch {
        Write-Host '[!] 防火墙恢复没完成（没点授权/不是管理员）：局域网端口可能仍处于放行状态，但不影响使用' -ForegroundColor Yellow
    }
}

# 3) 重启画面服务，让监听地址回到 127.0.0.1 + tailnet
$killed = 0
try {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'screen-server\.mjs' })
    foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch { } }
} catch { }
Write-Host ('[i] 正在重启画面服务（已停 ' + $killed + ' 个进程，守护会在约 10 秒内拉起）…') -ForegroundColor Cyan

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
