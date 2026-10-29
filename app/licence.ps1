<#
.SYNOPSIS
    许可证校验（随产品分发，内含公钥）

.DESCRIPTION
    设计目标：**防随手转发**，不是防破解。
    客户把安装包发给朋友 → 朋友机器码不同 → 许可证验不过 → 用不了 → 自然放弃。

    能做到：
      · 许可证绑定这一台电脑（CPU + 主板序列号）
      · 许可证带 RSA-2048 签名，客户没有私钥，伪造不了
      · 验不过时"软停"：程序照常启动，但不出画面，并告诉客户机器码和联系方式

    做不到（诚实说明）：
      · 客户如果把整台电脑备份拷走、或改源码，离线方案防不住
      · 没有服务器就没法远程吊销

.NOTES
    本文件的公钥是唯一可信源。私钥在 seller-keys\private.xml（卖家侧，绝不进产品包）。
    UTF-8 with BOM，PS 5.1。
#>

# 内嵌公钥（对应 seller-keys\private.xml，改了私钥这里必须同步换）
$script:LicencePublicKeyXml = '<RSAKeyValue><Modulus>0fXt+uBcg+IKmrycblhXiD5L9nNXF1CoXxfPc9opkNGgzji3FvJL9RyDAipG+lbgugLCkZSSftkOve/HhTzoW9QfEixV4VPwHz5aOMo5+r6H39i1htpRbZnE54Z4d+lftsOjZKO9C5g9QH7TaNNrrmUFlinnPe+5ilebgDsJ013Bc1c5R0/kg3abA8GhLtBMGnUyZ75u3wAddyhTHBa+soGtGOQoL39BrY9vBjAa8DXHxU+EskhdcFViBvOvoDcJlG1y59eInUqO26qpHemc3xpMy1C8y3xED5p18cORRt1uLr83D5ZRJXTiF77Fjg+pU77GnXKkGmMrXccm/ZuMEQ==</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>'

function Get-LicenceMachineCode {
    <#
      机器码：CPU ProcessorId + 主板序列号 → SHA256 → 取前 16 位十六进制，按 4 位分组。
      刻意不含 MachineGuid：那样客户重装系统就得重新发许可证，售后成本高。
      也刻意不含磁盘序列号：换硬盘不该失效。

      结果缓存到脚本同目录的 machine.id：查 CIM 每次几百毫秒，
      而守护进程每 8 秒校验一次，不缓存会一直占 CPU。

      改动（独立审查 M1）：原来缓存只校验格式、命中就直接返回，**永不复算**——
      等于把"绑定这台电脑"降级成"绑定这个文件"，客户复制一份 machine.id 就能把
      许可证搬到别的机器上。现在支持 -Force 跳过缓存重算；服务启动时用一次 -Force，
      日常守护仍走缓存（不然每 8 秒查一次 CIM 太贵）。
    #>
    param([switch]$Force)
    # 先读缓存（-Force 时跳过）
    $cacheFile = ''
    try { if ($PSScriptRoot) { $cacheFile = Join-Path $PSScriptRoot 'machine.id' } } catch { }
    if (-not $Force -and $cacheFile -and (Test-Path -LiteralPath $cacheFile)) {
        try {
            $cached = (Get-Content -LiteralPath $cacheFile -Raw).Trim()
            if ($cached -match '^[0-9A-F]{4}(-[0-9A-F]{4}){3}$') { return $cached }
        } catch { }
    }

    $parts = @()
    try {
        $cpu = Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1
        if ($cpu -and $cpu.ProcessorId) { $parts += ([string]$cpu.ProcessorId).Trim() }
    } catch { }
    try {
        $bd = Get-CimInstance Win32_BaseBoard -ErrorAction Stop
        if ($bd) {
            if ($bd.SerialNumber -and $bd.SerialNumber -notmatch 'To be filled|Default|[Xx]{4,}|^0+$') {
                $parts += ([string]$bd.SerialNumber).Trim()
            }
            if ($bd.Product) { $parts += ([string]$bd.Product).Trim() }
        }
    } catch { }

    # 硬件信息都拿不到时，退回 MachineGuid（至少还能绑定）
    if ($parts.Count -eq 0) {
        try {
            $mg = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid
            if ($mg) { $parts += ([string]$mg).Trim() }
        } catch { }
    }
    if ($parts.Count -eq 0) { return '' }

    $raw = ($parts -join '|').ToLowerInvariant()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($raw))
    } finally { $sha.Dispose() }
    $hex = (-join ($hash | ForEach-Object { $_.ToString('x2') })).Substring(0, 16).ToUpperInvariant()
    $code = ($hex -replace '(.{4})(?=.)', '$1-')
    # 写缓存（失败不影响返回）
    if ($cacheFile) {
        try { Set-Content -LiteralPath $cacheFile -Value $code -Encoding ascii } catch { }
    }
    return $code
}

function Get-LicencePath {
    param([string]$AppDir, [switch]$ForceMachine)
    if (-not $AppDir) { $AppDir = (Get-Location).Path }
    return (Join-Path $AppDir 'licence.json')
}

function Get-LicencePayloadString {
    <#
      签名用的规范化字符串：固定字段顺序、固定分隔符。
      签发端和校验端必须用同一个函数生成，否则验签永远失败。
    #>
    param($Payload)
    $expires = if ($null -eq $Payload.expires -or $Payload.expires -eq '') { 'never' } else { [string]$Payload.expires }
    return @(
        [string]$Payload.name,
        [string]$Payload.machine,
        [string]$Payload.issued,
        $expires,
        [string]$Payload.edition,
        [string]$Payload.ver
    ) -join "`n"
}

function Test-Licence {
    <#
      返回一个对象：
        State  = 'ok' | 'missing' | 'bad-format' | 'bad-signature' | 'machine-mismatch' | 'expired' | 'error'
        Usable = 布尔（只有 ok 才是 true）
        MachineCode = 本机机器码
        Name/Issued/Expires/Edition = 许可证里的信息（能读出来时）
        Message = 给客户看的一句话
    #>
    param([string]$AppDir, [switch]$ForceMachine)

    $machine = ''
    try { $machine = Get-LicenceMachineCode -Force:$ForceMachine } catch { }

    $result = [pscustomobject]@{
        State       = 'error'
        Usable      = $false
        MachineCode = $machine
        Name        = ''
        Issued      = ''
        Expires     = ''
        Edition     = ''
        Message     = ''
    }

    $path = Get-LicencePath -AppDir $AppDir
    if (-not (Test-Path -LiteralPath $path)) {
        $result.State = 'missing'
        $result.Message = '这台电脑还没有许可证。'
        return $result
    }

    try {
        $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8
        $doc = $raw | ConvertFrom-Json
    } catch {
        $result.State = 'bad-format'
        $result.Message = '许可证文件读不出来（可能损坏）。'
        return $result
    }

    if (-not $doc -or -not $doc.payload -or -not $doc.sig) {
        $result.State = 'bad-format'
        $result.Message = '许可证文件格式不对。'
        return $result
    }

    $p = $doc.payload
    # 改动（第二轮 P2-2 / H3-c）：六个字段里禁止换行。
    # 签名覆盖的 payload 是用 "`n" 拼起来的，字段自身含换行时同一段签名可以被重新切成
    # 不同 payload（见 screen-server.mjs 里同一段注释）。两端一起拒绝，正常许可证不受影响。
    foreach ($fieldName in @('name', 'machine', 'issued', 'expires', 'edition', 'ver')) {
        if (([string]$p.$fieldName) -match "[`r`n]") {
            $result.State = 'bad-format'
            $result.Message = '许可证字段里不能有换行。'
            return $result
        }
    }
    $result.Name    = [string]$p.name
    $result.Issued  = [string]$p.issued
    $result.Edition = [string]$p.edition
    $result.Expires = if ($null -eq $p.expires -or $p.expires -eq '') { 'never' } else { [string]$p.expires }

    # 1) 验签
    $data = Get-LicencePayloadString -Payload $p
    try {
        $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
        $rsa.FromXmlString($script:LicencePublicKeyXml)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $sigBytes = [Convert]::FromBase64String([string]$doc.sig)
            $ok = $rsa.VerifyData([System.Text.Encoding]::UTF8.GetBytes($data), $sha, $sigBytes)
        } finally { $sha.Dispose(); $rsa.Dispose() }
    } catch {
        $ok = $false
    }
    if (-not $ok) {
        $result.State = 'bad-signature'
        $result.Message = '许可证签名不对（可能被改过，或者不是我们发的）。'
        return $result
    }

    # 2) 机器码匹配
    if (-not $machine) {
        $result.State = 'error'
        $result.Message = '读不到这台电脑的机器码，没法校验。'
        return $result
    }
    if (([string]$p.machine).Trim().ToUpperInvariant() -ne $machine.ToUpperInvariant()) {
        $result.State = 'machine-mismatch'
        $result.Message = '这个许可证是发给另一台电脑的。'
        return $result
    }

    # 3) 有效期（expires 为空/never 表示永久）
    # 改动（独立审查 L2）：原来用 [datetime]::Parse 宽松解析，解析失败时
    # $exp 为 $null 就**跳过**了过期检查 —— 也就是 fail-open：
    # 把有效期写成 "abc" 或 "2026/13/45" 之类的非法值，就等于永久有效。
    # 现在只接受严格的 yyyy-MM-dd；解析不出来直接判为格式错误（fail-closed）。
    if ($result.Expires -and $result.Expires -ne 'never') {
        $exp = [datetime]::MinValue
        $styles = [System.Globalization.DateTimeStyles]::None
        $culture = [System.Globalization.CultureInfo]::InvariantCulture
        $parsed = [datetime]::TryParseExact($result.Expires.Trim(), 'yyyy-MM-dd', $culture, $styles, [ref]$exp)
        if (-not $parsed) {
            $result.State = 'bad-format'
            $result.Message = '许可证的有效期格式不对（应为 yyyy-MM-dd）。'
            return $result
        }
        if ($exp.Date -lt (Get-Date).Date) {
            $result.State = 'expired'
            $result.Message = ('许可证已于 ' + $exp.ToString('yyyy-MM-dd') + ' 到期。')
            return $result
        }
    }

    $result.State = 'ok'
    $result.Usable = $true
    $result.Message = '许可证有效。'
    return $result
}

function Get-LicenceDenyReason {
    param($Licence)
    if (-not $Licence) { return '许可证状态未知' }
    switch ($Licence.State) {
        'ok'               { return '' }
        'missing'          { return '这台电脑还没有许可证' }
        'bad-format'       { return '许可证文件损坏' }
        'bad-signature'    { return '许可证无效（签名不对）' }
        'machine-mismatch' { return '许可证是发给另一台电脑的' }
        'expired'          { return '许可证已到期' }
        default            { return '许可证校验失败' }
    }
}
