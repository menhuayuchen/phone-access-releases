<#
.SYNOPSIS
    Tailscale HTTPS / PWA 支持（让手机能把页面"安装到桌面"）

.DESCRIPTION
    为什么需要这一层：
      手机要"安装成 App"必须满足两个条件——①HTTPS（service worker 只在安全上下文可用）
      ②manifest 和 service worker 齐全。manifest/SW 我们已经有了，缺的是 HTTPS。

    HTTPS 从哪来：
      tailscale serve 会用 Let's Encrypt 给 <机器名>.<tailnet>.ts.net 签证书，
      但前提是**这个 tailnet 自己启用了 HTTPS Certificates**——那是每个客户在
      Tailscale 后台的一次性设置，不跟安装包走。

    所以本模块做三件事：
      1) 探测这台机器的 tailnet 能不能签证书（= HTTPS 是否已启用）
      2) 能签就自动把 443 端口指到画面服务；不能签就返回一句可读的原因和指引
      3) 读回当前 443 是否已经指向画面服务（供网址生成用）

.NOTES
    UTF-8 with BOM，PS 5.1。所有命令都带超时保护：
    HTTPS 没启用时 tailscale serve 会挂住等授权（实测 >4 分钟），不能让它拖死安装流程。
#>

function Get-TailnetDnsName {
    param([string]$TailscaleExe)
    if (-not $TailscaleExe) { return '' }
    try {
        $json = & $TailscaleExe status --json 2>$null | Out-String
        if (-not $json) { return '' }
        $st = $json | ConvertFrom-Json
        $name = [string]$st.Self.DNSName
        return $name.TrimEnd('.')
    } catch { return '' }
}

function Test-TailnetHttps {
    <#
      探测能不能为这台机器签证书。
      成功返回 @{ Available = $true; DnsName = ... }
      失败返回 @{ Available = $false; DnsName = ...; Hint = '<给客户看的一句话>' }

      实现方式：真去签一次证书到临时目录。比解析 serve 的报错可靠。
      证书签发有网络往返，所以调用方应该做频率限制（见 Get-HttpsProbeCooldown）。
    #>
    param(
        [string]$TailscaleExe,
        [string]$DnsName = '',
        [int]$TimeoutSec = 45
    )
    $res = [pscustomobject]@{ Available = $false; DnsName = $DnsName; Hint = '' }
    if (-not $TailscaleExe) { $res.Hint = '这台电脑没装 Tailscale'; return $res }
    if (-not $DnsName) { $DnsName = Get-TailnetDnsName -TailscaleExe $TailscaleExe; $res.DnsName = $DnsName }
    if (-not $DnsName) { $res.Hint = 'Tailscale 没连上（取不到机器名）'; return $res }

    $tmp = Join-Path $env:TEMP ('pa-cert-' + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        $job = Start-Job -ScriptBlock {
            param($exe, $dir, $name)
            Set-Location $dir
            & $exe cert $name 2>&1
        } -ArgumentList $TailscaleExe, $tmp, $DnsName
        $done = Wait-Job $job -Timeout $TimeoutSec
        if ($done) {
            $out = (Receive-Job $job) -join "`n"
            $crt = Join-Path $tmp ($DnsName + '.crt')
            if (Test-Path -LiteralPath $crt) {
                $res.Available = $true
            } else {
                # 没签出来：把 Tailscale 的原话压成一句给客户看
                $hint = ''
                if ($out -match 'https?://\S*admin\S*dns\S*') { $hint = '这个 Tailscale 账号还没启用 HTTPS。一次性设置：打开 Tailscale 后台 → DNS → HTTPS Certificates → 点 Enable HTTPS（同一个页面里就有链接），然后回到手机页面再点一次「一键开启远程 HTTPS」。' }
                elseif ($out -match 'HTTPS is not enabled|https.*(disabled|not enabled)') { $hint = '这个 Tailscale 账号还没启用 HTTPS。一次性设置：打开 Tailscale 后台 → DNS → HTTPS Certificates → 点 Enable HTTPS（同一个页面里就有链接），然后回到手机页面再点一次「一键开启远程 HTTPS」。' }
                elseif ($out -match 'tailnet.*does not support|not available') { $hint = '当前 tailnet 不支持自动签发证书（多半是没开 HTTPS Certificates）。手机暂时装不了 App，用浏览器打开仍然可用。' }
                elseif ($out.Trim()) { $hint = '签发证书失败：' + (($out.Trim() -split "`n")[0]) }
                else { $hint = '签发证书失败（无输出）' }
                $res.Hint = $hint
            }
        } else {
            Stop-Job $job -ErrorAction SilentlyContinue
            Remove-Job $job -Force -ErrorAction SilentlyContinue
            $res.Hint = '等待证书超时（HTTPS 可能还没在 Tailscale 后台启用）'
        }
        Remove-Job $job -Force -ErrorAction SilentlyContinue
    } catch {
        $res.Hint = '探测 HTTPS 时出错：' + $_.Exception.Message
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    return $res
}

function Get-HttpsServeUrl {
    <#
      读当前 tailscale serve 配置：443 端口的 / 是不是指向本机画面端口。
      是 → 返回 https://<机器名>/
      否 → 返回 $null
    #>
    param([string]$TailscaleExe, [int]$ScreenPort)
    if (-not $TailscaleExe) { return $null }
    try {
        $json = & $TailscaleExe serve status --json 2>$null | Out-String
        if (-not $json) { return $null }
        $cfg = $json | ConvertFrom-Json
        if (-not $cfg.Web) { return $null }
        $want = 'http://127.0.0.1:' + $ScreenPort
        foreach ($name in $cfg.Web.PSObject.Properties.Name) {
            if ($name -notmatch ':443$') { continue }
            $hostName = ($name -replace ':443$', '')
            $handlers = $cfg.Web.$name.Handlers
            if (-not $handlers) { continue }
            $root = $handlers.'/'
            if ($root -and ([string]$root.Proxy).TrimEnd('/') -eq $want) {
                return ('https://' + $hostName + '/')
            }
        }
    } catch { }
    return $null
}

function Test-HttpsPortBusyByOther {
    <#
      443 端口是不是已经被别的东西（不是我们）占了。
      占着就别碰——覆盖客户的现有配置是事故。
    #>
    param([string]$TailscaleExe, [int]$ScreenPort)
    try {
        $json = & $TailscaleExe serve status --json 2>$null | Out-String
        if (-not $json) { return $false }
        $cfg = $json | ConvertFrom-Json
        if (-not $cfg.Web) { return $false }
        $want = 'http://127.0.0.1:' + $ScreenPort
        foreach ($name in $cfg.Web.PSObject.Properties.Name) {
            if ($name -notmatch ':443$') { continue }
            $handlers = $cfg.Web.$name.Handlers
            if (-not $handlers) { continue }
            $root = $handlers.'/'
            if ($root -and ([string]$root.Proxy).TrimEnd('/') -ne $want) { return $true }
        }
        return $false
    } catch { return $true }   # 读不清就当成"别碰"
}

function Enable-HttpsServeForScreen {
    <#
      把 https://<机器名>/ 指到画面服务。
      返回 @{ Ok=bool; Url=''; Note='' }

      安全顺序：先看 443 是否被别的配置占着 → 再看 HTTPS 能不能签 → 最后才动 serve。
    #>
    param(
        [string]$TailscaleExe,
        [int]$ScreenPort,
        [int]$TimeoutSec = 60,
        [switch]$SkipProbe
    )
    $res = [pscustomobject]@{ Ok = $false; Url = ''; Note = '' }
    if (-not $TailscaleExe) { $res.Note = '没装 Tailscale'; return $res }

    $existing = Get-HttpsServeUrl -TailscaleExe $TailscaleExe -ScreenPort $ScreenPort
    if ($existing) { $res.Ok = $true; $res.Url = $existing; $res.Note = '已经配置好了'; return $res }

    if (Test-HttpsPortBusyByOther -TailscaleExe $TailscaleExe -ScreenPort $ScreenPort) {
        $res.Note = '443 端口已经被 Tailscale 里别的服务占用，没有改动它'
        return $res
    }

    if (-not $SkipProbe) {
        $probe = Test-TailnetHttps -TailscaleExe $TailscaleExe
        if (-not $probe.Available) { $res.Note = $probe.Hint; return $res }
    }

    try {
        $job = Start-Job -ScriptBlock {
            param($exe, $port)
            & $exe serve --bg --https=443 ('http://127.0.0.1:' + $port) 2>&1
        } -ArgumentList $TailscaleExe, $ScreenPort
        $done = Wait-Job $job -Timeout $TimeoutSec
        if ($done) { $out = (Receive-Job $job) -join "`n" } else { Stop-Job $job -ErrorAction SilentlyContinue; $out = '' }
        Remove-Job $job -Force -ErrorAction SilentlyContinue

        $url = Get-HttpsServeUrl -TailscaleExe $TailscaleExe -ScreenPort $ScreenPort
        if ($url) { $res.Ok = $true; $res.Url = $url; $res.Note = '已开启' }
        else {
            $res.Note = '开启失败'
            if ($out) { $res.Note += '：' + (($out.Trim() -split "`n")[0]) }
        }
    } catch {
        $res.Note = '开启时出错：' + $_.Exception.Message
    }
    return $res
}
