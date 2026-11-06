<#
.SYNOPSIS
    手机入口 · 一键查看/生成二维码，或换一把新密钥

.DESCRIPTION
    客户双击桌面「轻屏」文件夹里的「手机入口」就能用，不用记命令。

    菜单：
      1) 显示手机入口 —— 打印网址 + 生成二维码图片并打开
      2) 换一把新密钥 —— 立刻吊销所有旧链接和已登录设备，然后生成新二维码
      0) 退出

.NOTES
    文件名用 ASCII（entry.ps1）是刻意的：调用它的 .cmd 内容必须是纯 ASCII，
    否则 cmd.exe 在 UTF-8 控制台下会把中文文件名拆成命令。
    本文件必须 UTF-8 with BOM。
#>
[CmdletBinding()]
param([switch]$NoPause)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
try { . (Join-Path $here 'product-config.ps1') } catch { }

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Head([string]$m) { Say ''; Say ('── ' + $m) 'Cyan' }

# ---------- 读配置 ----------
$cfg = $null
try { $cfg = Get-ProductConfig -AppDir $here } catch { }
if (-not $cfg) {
    Say '[x] 读不到配置（product.config.json 缺失或坏了）。' 'Red'
    Say '    请重新双击桌面「轻屏」文件夹里的「启动」。'
    if (-not $NoPause) { Read-Host '按回车退出' | Out-Null }
    exit 1
}

$portScreen = [int]$cfg.ports.screen
$portDsh    = [int]$cfg.ports.dsh
$enableDsh  = [bool]$cfg.enableDsh

# ---------- 找密钥 ----------
function Get-Key {
    $f = Join-Path $here 'screen.key'
    if (Test-Path -LiteralPath $f) { return ((Get-Content -LiteralPath $f -Raw) -replace '\s', '') }
    return ''
}

# ---------- 服务是不是真的在用这把（最新的）密钥 ----------
# 用户反馈：手机入口给出来的网址不一定是最新的。
# 根因有两个：
#   1) screen-url.txt 是 start-screen.ps1 写的，换密钥后如果启动脚本没跑完，
#      文件里还是旧密钥 —— 而 Show-Entries 原来直接拿这个文件去显示/出二维码。
#   2) 画面服务在启动时把密钥读进内存，之后不再重读。换了 screen.key
#      但服务没重启，服务仍在用旧密钥。
# 所以这里做两件事：显示时**永远用 screen.key 里的当前密钥**重建网址；
# 并判断服务进程是不是比密钥文件更早启动（更早 = 它还拿着旧密钥）。
function Test-ServerUsesCurrentKey {
    $keyFile = Join-Path $here 'screen.key'
    if (-not (Test-Path -LiteralPath $keyFile)) { return 'nokey' }
    try { $keyMtime = (Get-Item -LiteralPath $keyFile).LastWriteTime } catch { return 'unknown' }
    $procs = @()
    try {
        $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match 'screen-server\.mjs' })
    } catch { return 'unknown' }
    if ($procs.Count -eq 0) { return 'down' }
    $newest = $null
    foreach ($p in $procs) {
        try { if ($p.CreationDate -and (-not $newest -or $p.CreationDate -gt $newest)) { $newest = $p.CreationDate } } catch { }
    }
    if (-not $newest) { return 'unknown' }
    # 给 2 秒容差：同时启动时文件时间和进程时间可能挨得很近
    if ($newest -lt $keyMtime.AddSeconds(-2)) { return 'stale' }
    return 'ok'
}

# 用当前密钥重建网址：保留原网址的协议和主机，只把 k= 换成最新的
function Rebuild-UrlWithKey([string]$templateUrl, [string]$key) {
    if (-not $templateUrl) { return '' }
    $m = [regex]::Match($templateUrl.Trim(), '^(?<base>https?://[^?\s]+)')
    if (-not $m.Success) { return '' }
    return ($m.Groups['base'].Value + '?k=' + $key)
}

# ---------- 找本机私有网络地址（不写死）----------
function Get-MyIp {
    $tsExe = ''
    try {
        $r = Resolve-ProductRuntime -AppDir $here -Name 'tailscale' -Config $cfg -WellKnownDirs @('C:\Program Files\Tailscale', 'C:\Program Files (x86)\Tailscale')
        if ($r -and $r.Path) { $tsExe = $r.Path }
    } catch { }
    if (-not $tsExe) {
        foreach ($p in @('C:\Program Files\Tailscale\tailscale.exe', 'C:\Program Files (x86)\Tailscale\tailscale.exe')) {
            if (Test-Path -LiteralPath $p) { $tsExe = $p; break }
        }
    }
    if ($tsExe) {
        try {
            $ip = (& $tsExe ip -4 2>$null | Select-Object -First 1)
            if ($ip) { return ([string]$ip).Trim() }
        } catch { }
        try {
            $info = Get-TailscaleInfo -TailscaleExe $tsExe
            if ($info -and $info.Ip) { return [string]$info.Ip }
        } catch { }
    }
    # 兜底：从已有网址文件里抠 IP
    foreach ($f in @('screen-url.txt', 'login-url.txt')) {
        $p = Join-Path $here $f
        if (Test-Path -LiteralPath $p) {
            $m = [regex]::Match((Get-Content -LiteralPath $p -Raw), '(\d+\.\d+\.\d+\.\d+)')
            if ($m.Success) { return $m.Groups[1].Value }
        }
    }
    return ''
}

# ---------- 找 python（生成二维码用）----------
function Get-PythonExe {
    if ($cfg -and $cfg.runtime -and $cfg.runtime.pythonPath) {
        if (Test-Path -LiteralPath $cfg.runtime.pythonPath) { return $cfg.runtime.pythonPath }
    }
    $local = Join-Path $here 'runtime\python.exe'
    if (Test-Path -LiteralPath $local) { return $local }
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return ''
}

# ---------- 生成二维码 ----------
function New-Qr([string]$text, [string]$outFile) {
    $py = Get-PythonExe
    if (-not $py) { return $false }
    $script = Join-Path $here 'make-qr.py'
    if (-not (Test-Path -LiteralPath $script)) { return $false }
    $dir = Split-Path -Parent $outFile
    try { if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null } } catch { }
    try {
        & $py $script $text $outFile *> $null
        return (Test-Path -LiteralPath $outFile)
    } catch { return $false }
}

# ---------- 1) 显示入口 ----------
function Show-Entries {
    Head '手机入口'
    $ip = Get-MyIp
    $key = Get-Key
    if (-not $key) { Say '  [!] 没有 screen.key —— 请先双击「启动」，或选 2) 生成一把新的。' 'Yellow'; return }

    # 注意：这里**故意读文件而不自己拼地址**。start-screen.ps1 已经把两个入口都落盘了：
    #   screen-url.txt    = 主入口（Tailscale HTTPS 可用时就是域名形式 → 能装成 App）
    #   screen-url-ip.txt = 备用入口（永远是 http://<tailnet IP>:<port>/?k=…）
    # 自己拼一份很容易和它对不上（以前就出过：这里还在发 http 地址，扫码装不成 App）。
    $primary = ''
    $fallback = ''
    $urlFile = Join-Path $here 'screen-url.txt'
    $ipFile = Join-Path $here 'screen-url-ip.txt'
    if (Test-Path -LiteralPath $urlFile) { $primary = (Get-Content -LiteralPath $urlFile -Raw).Trim() }
    if (Test-Path -LiteralPath $ipFile) { $fallback = (Get-Content -LiteralPath $ipFile -Raw).Trim() }

    if (-not $primary -or $primary -notmatch '^https?://') {
        if (-not $ip) { Say '  [!] 没拿到本机私有网络地址，也没有 screen-url.txt。请先双击「启动」。' 'Yellow'; return }
        $primary = 'http://' + $ip + ':' + $portScreen + '/?k=' + $key
    }
    if (-not $fallback -and $ip) { $fallback = 'http://' + $ip + ':' + $portScreen + '/?k=' + $key }
    if ($fallback -eq $primary) { $fallback = '' }   # 两个一样就不重复显示

    # ★ 关键：网址里的 k= 一律**用当前 screen.key 覆盖**，不用文件里的旧值。
    # 用户反馈过"手机入口给的密钥不一定是最新的"：换过密钥后 screen-url.txt 可能是旧的，
    # 直接照抄文件就会发出一条已经失效的链接。协议和主机沿用文件里的（保留 https 域名形态），
    # 只有密钥取最新的。
    $primaryOld = $primary
    $primary = Rebuild-UrlWithKey $primary $key
    if (-not $primary) { $primary = $primaryOld }
    if ($fallback) {
        $fallback = Rebuild-UrlWithKey $fallback $key
    }
    if ($fallback -eq $primary) { $fallback = '' }

    # ★ 服务是不是真在用这把新密钥（换了密钥但服务没重启 = 链接仍然打不开）
    $svcState = Test-ServerUsesCurrentKey
    if ($svcState -eq 'stale') {
        Say ''
        Say '  [!] 检测到画面服务还在用旧密钥。正在自动重启让它生效…' 'Yellow'
        $starter = Join-Path $here 'start-phone-access.cmd'
        if (Test-Path -LiteralPath $starter) {
            try { & "$env:SystemRoot\System32\cmd.exe" /c "`"$starter`"" *> $null } catch { }
            # 等到进程比密钥文件更新（最多 40 秒）
            for ($i = 0; $i -lt 20; $i++) {
                Start-Sleep -Seconds 2
                if ((Test-ServerUsesCurrentKey) -eq 'ok') { break }
            }
        }
        $svcState = Test-ServerUsesCurrentKey
        if ($svcState -eq 'ok') { Say '  [OK] 服务已重启，下面的网址是最新的。' 'Green' }
        else { Say '  [!] 服务还没起来。请双击桌面「启动」，然后再打开「手机入口」一次。' 'Yellow' }
    } elseif ($svcState -eq 'down') {
        Say ''
        Say '  [!] 画面服务现在没在运行。下面的网址要等它起来才能用（双击桌面「启动」）。' 'Yellow'
    }

    $primaryIsHttps = ($primary -match '^https://')

    # 改动（用户的桌面整洁要求）：二维码和网址统一放进「桌面\轻屏\二维码」，
    # 和报告一样都收在同一个文件夹里，桌面不放散东西。
    $qrDir = ''
    try {
        $desk = [Environment]::GetFolderPath('Desktop')
        if ($desk -and (Test-Path -LiteralPath $desk)) {
            $qrDir = Join-Path (Join-Path $desk '轻屏') '二维码'
        }
    } catch { }
    if (-not $qrDir) { $qrDir = Join-Path $here '二维码' }
    $files = @()

    Say ''
    Say '  手机画面（看屏幕 + 触控）—— 两个地址任选一个:' 'Green'
    Say ''
    $no = 1
    Say ("  [$no] 主入口" + $(if ($primaryIsHttps) { '  ← 推荐' } else { '' })) 'Cyan'
    Say ('       ' + $primary) 'White'
    if ($primaryIsHttps) {
        Say '       · 加密传输（https）' 'Cyan'
        Say '       · 可以在手机上"添加到主屏幕"变成 App 图标' 'Cyan'
    } else {
        Say '       · 是 http 地址，只能浏览器打开，装不成 App' 'Yellow'
        Say '       · 想在手机上装成 App：去 Tailscale 后台开 HTTPS，然后重启一次「启动」' 'Yellow'
    }
    if ($fallback) {
        $no++
        Say ''
        Say ("  [$no] 备用入口  ← 主入口打不开时用这个") 'Cyan'
        Say ('       ' + $fallback) 'White'
        Say '       · 是数字 IP，不依赖域名解析，一定能连' 'Cyan'
        Say '       · 但装不成 App（需要在 https 地址下才能添加桌面图标）' 'Yellow'
    }

    if ($enableDsh -and $ip) {
        Say ''
        Say '  DSH 对话控制台（永久入口，不会过期）:' 'Green'
        Say ('       http://' + $ip + ':' + $portDsh + '/go?k=' + $key) 'White'
    }

    Say ''
    Say '  正在生成二维码…'
    $p1 = Join-Path $qrDir '手机画面二维码-主入口.png'
    if (New-Qr $primary $p1) {
        $files += $p1
        Say ('    [OK] 主入口二维码' + $(if ($primaryIsHttps) { '（https，能装 App）' } else { '' }))
    } else { Say '    [!] 二维码没生成（这台电脑没有 python）—— 直接用上面的网址' 'Yellow' }

    if ($fallback) {
        $p1b = Join-Path $qrDir '手机画面二维码-备用http.png'
        if (New-Qr $fallback $p1b) { $files += $p1b; Say '    [OK] 备用入口二维码（http）' } else { Say '    [!] 备用二维码没生成' 'Yellow' }
    }

    if ($enableDsh -and $ip) {
        $dshUrl = 'http://' + $ip + ':' + $portDsh + '/go?k=' + $key
        $p2 = Join-Path $qrDir 'DSH控制台二维码.png'
        if (New-Qr $dshUrl $p2) { $files += $p2; Say '    [OK] DSH 控制台二维码' } else { Say '    [!] DSH 二维码没生成' 'Yellow' }
    }

    # 网址也存一份文本，方便复制
    try {
        $txt = Join-Path $qrDir '网址.txt'
        $lines = @()
        $lines += '手机画面 —— 两个地址任选一个'
        $lines += ''
        $lines += '【主入口】' + $(if ($primaryIsHttps) { '（https，推荐：能装成 App 图标）' } else { '（http，装不成 App）' })
        $lines += '  ' + $primary
        if ($fallback) {
            $lines += ''
            $lines += '【备用入口】（主入口打不开时用这个，数字 IP 不依赖域名解析）'
            $lines += '  ' + $fallback
        }
        if ($enableDsh -and $ip) {
            $lines += ''
            $lines += '【DSH 对话控制台】（永久入口，不会过期）'
            $lines += '  http://' + $ip + ':' + $portDsh + '/go?k=' + $key
        }
        $lines += ''
        if ($primaryIsHttps) { $lines += '提示：用【主入口】打开后，可以把页面“添加到主屏幕”，用起来像 App。' }
        $lines += '注意：这些网址里的 k= 就是万能钥匙，别截图发给别人。'
        Set-Content -LiteralPath $txt -Value ($lines -join "`r`n") -Encoding UTF8
    } catch { }

    foreach ($f in $files) { try { Start-Process -FilePath $f } catch { } }

    Say ''
    Say '  提醒：网址里的 k= 是万能钥匙，能看能操作这台电脑。' 'Yellow'
    Say '        别截图发人、别贴在聊天里。怀疑泄漏就选 2) 换一把。' 'Yellow'
    Say ('  二维码和网址已存到：' + $qrDir)
}

# ---------- 2) 换密钥 ----------
function Rotate-Key {
    Head '换一把新密钥'
    Say '  换完之后：' 'Yellow'
    Say '    · 所有旧的网址和二维码立刻失效'
    Say '    · 所有已经记住登录的手机/平板立刻失效（要重新扫码）'
    Say '    · 新的二维码会重新生成'
    Say ''
    $ans = Read-Host '  确定要换吗？输入 YES 继续（直接回车取消）'
    if ($ans -ne 'YES') { Say '  已取消，什么都没改。' 'Gray'; return }

    $bytes = New-Object byte[] 16
    try { [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes) }
    catch {
        $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
        $rng.GetBytes($bytes); $rng.Dispose()
    }
    $new = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    $keyFile = Join-Path $here 'screen.key'
    try { Set-Content -LiteralPath $keyFile -Value $new -Encoding ascii }
    catch { Say ('  [x] 写不进密钥文件：' + $_.Exception.Message) 'Red'; return }
    Say ('  新密钥已生成：' + $new.Substring(0, 6) + '…（' + $new.Length + ' 位 = 128 bit）') 'Green'

    # 让服务按新密钥重建网址/二维码，并重启注入通道
    Say ''
    Say '  正在重启服务让新密钥生效…'
    $starter = Join-Path $here 'start-phone-access.cmd'
    if (Test-Path -LiteralPath $starter) {
        try {
            & "$env:SystemRoot\System32\cmd.exe" /c "`"$starter`"" *> $null
        } catch { }
    }
    # 改动：原来这里固定 Start-Sleep 4 秒，但启动脚本本身要十几秒才能把画面服务拉起来。
    # 于是紧接着的 Show-Entries 读到的是**旧的 screen-url.txt**，用户拿到已经失效的链接
    # （这就是"手机入口给的密钥不一定是最新的"的另一半原因）。
    # 现在改成轮询：等到画面服务进程确实比密钥文件新，最多 40 秒。
    $ready = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 2
        if ((Test-ServerUsesCurrentKey) -eq 'ok') { $ready = $true; break }
    }
    if (-not $ready) {
        Say '  [!] 服务还没确认用上新密钥，多等一会再看（下面显示的是当前密钥，链接是对的）。' 'Yellow'
    }
    # 重新生成网址文件，让 screen-url.txt / screen-url-ip.txt 也带上新密钥
    $screenStarter = Join-Path $here 'start-screen.ps1'
    if (Test-Path -LiteralPath $screenStarter) {
        try { & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $screenStarter -Quiet *> $null } catch { }
    }
    Show-Entries
}

# ---------- 菜单 ----------
while ($true) {
    Write-Host ''
    Write-Host '=============================================' -ForegroundColor Cyan
    Write-Host '   轻屏 · 手机入口' -ForegroundColor Cyan
    Write-Host '=============================================' -ForegroundColor Cyan
    Write-Host '  1) 显示手机入口（网址 + 二维码）'
    Write-Host '  2) 换一把新密钥（旧链接全部失效）'
    Write-Host '  0) 退出'
    Write-Host ''
    $choice = Read-Host '  请选择'
    if ($choice -eq '1') { Show-Entries }
    elseif ($choice -eq '2') { Rotate-Key }
    elseif ($choice -eq '0' -or $choice -eq '') { break }
    else { Say '  只能输入 0 / 1 / 2' 'Yellow' }
    Write-Host ''
    $null = Read-Host '  按回车回到菜单'
}

Say ''
Say '已退出。'
if (-not $NoPause) { }  # 菜单已有回车，不再多停一次
