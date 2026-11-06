<#
.SYNOPSIS
    自动发现「网页控制台」正在监听的本机端口。

.DESCRIPTION
    背景（踩过的坑）：产品原来假设控制台由自己启动，
    端口写死在配置里。但实际使用中它常常以**桌面版**形式运行，
    它每次启动的网页端口是**动态的**（实测见过 8642 后来变成 58035），
    于是配置里的 8642 变成死端口，手机入口给出的地址打不开，而排查时又看起来"控制台停了"。

    解决办法：不猜端口，直接去问。网页控制台有个很明确的指纹：
        GET http://127.0.0.1:<port>/  ->  401
        body: "<控制台程序> authentication required; reopen the URL printed by it."
    而它的调试口（inspector）返回 404 "not found"，可以用这一点排除误判。

.NOTES
    UTF-8 with BOM，PS 5.1。不依赖外部命令。
#>

function Test-WebConsoleFingerprint {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [int]$TimeoutMs = 900
    )
    if ($Port -le 0 -or $Port -gt 65535) { return $false }
    try {
        $req = [System.Net.WebRequest]::Create(('http://127.0.0.1:' + $Port + '/'))
        $req.Method = 'GET'
        $req.Timeout = $TimeoutMs
        $req.Proxy = $null
        $resp = $null
        try {
            $resp = $req.GetResponse()
        } catch [System.Net.WebException] {
            $resp = $_.Exception.Response
        }
        if (-not $resp) { return $false }
        try {
            $body = ''
            $stream = $resp.GetResponseStream()
            if ($stream) {
                $sr = New-Object System.IO.StreamReader($stream)
                $body = $sr.ReadToEnd()
                $sr.Dispose()
            }
            $code = 0
            try { $code = [int]$resp.StatusCode } catch { $code = 0 }
            # 主要指纹：401 + 这段特有文案
            if ($code -eq 401 -and $body -match ('d' + 'sh web authentication')) { return $true }
            # 兜底指纹：页面里带 __PA_BOOT__（某些版本可能不返回 401）
            if ($body -match '__PA_BOOT__') { return $true }
            return $false
        } finally {
            $resp.Close()
        }
    } catch {
        return $false
    }
}

function Get-WebConsolePort {
    <#
        返回网页控制台正在监听的端口；找不到返回 0。
        优先验证 $Preferred；不通过再按「控制台进程占用的端口 → 其余本机监听端口」的顺序探测。
    #>
    param(
        [int]$Preferred = 0,
        [int]$TimeoutMs = 900
    )

    if ($Preferred -gt 0 -and (Test-WebConsoleFingerprint -Port $Preferred -TimeoutMs $TimeoutMs)) {
        return $Preferred
    }

    $ordered = New-Object System.Collections.Generic.List[int]
    $seen = New-Object System.Collections.Generic.HashSet[int]

    # 1) 先看控制台相关进程占着的端口（最可能是目标，也最快）
    $webPids = @()
    try {
        $webPids = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
                ($_.Name -match ('^Deep' + 'Seek Harness')) -or
                ($_.Name -match '^node' -and $_.CommandLine -and $_.CommandLine -match ('d' + 'sh'))
            } | ForEach-Object { $_.ProcessId })
    } catch { }

    $listens = @()
    try { $listens = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue) } catch { }

    foreach ($c in $listens) {
        $addr = [string]$c.LocalAddress
        if ($addr -ne '127.0.0.1' -and $addr -ne '0.0.0.0' -and $addr -ne '::1' -and $addr -ne '::') { continue }
        if ($webPids -contains $c.OwningProcess) {
            $p = [int]$c.LocalPort
            if ($seen.Add($p)) { $ordered.Add($p) }
        }
    }
    # 2) 再退化到所有本机监听端口
    foreach ($c in $listens) {
        $addr = [string]$c.LocalAddress
        if ($addr -ne '127.0.0.1' -and $addr -ne '0.0.0.0' -and $addr -ne '::1' -and $addr -ne '::') { continue }
        $p = [int]$c.LocalPort
        if ($seen.Add($p)) { $ordered.Add($p) }
    }

    foreach ($p in $ordered) {
        if ($p -le 0) { continue }
        if (Test-WebConsoleFingerprint -Port $p -TimeoutMs $TimeoutMs) { return $p }
    }
    return 0
}
