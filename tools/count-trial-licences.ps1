<#
.SYNOPSIS
    卖家用：查某台电脑买过几次「体验版」（人工执行「每台电脑最多 3 次」）

.DESCRIPTION
    扫描 seller-keys\licence-*.json（make-licence.ps1 每次签发的记录），
    统计 payload.machine 相同、payload.edition 是 trial / trial30 / month 的许可证。

    为什么是人工核对：产品是离线授权（没有中心服务器），客户端无法可靠地"记住买过几次"——
    删文件/重装都能绕过。所以次数靠卖家的签发记录 + 本脚本核对；这些 licence-*.json
    就是你的销售台账，别删。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\count-trial-licences.ps1 -Machine "A1B2-C3D4-E5F6-7890"

.NOTES
    UTF-8 with BOM，PS 5.1。
#>
param(
    [Parameter(Mandatory = $true)][string]$Machine,
    [string]$Dir = '',
    [int]$Limit = 3
)

$ErrorActionPreference = 'Stop'
if (-not $Dir) {
    $root = Split-Path -Parent $PSScriptRoot
    $Dir = Join-Path $root 'seller-keys'
}
$m = ($Machine -replace '\s', '').ToUpperInvariant()
if ($m -notmatch '^[0-9A-F]{4}(-[0-9A-F]{4}){3}$') {
    Write-Host ('[x] 机器码格式不对：' + $Machine + '（应该像 A1B2-C3D4-E5F6-7890）') -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $Dir)) {
    Write-Host ('[x] 找不到签发记录目录：' + $Dir) -ForegroundColor Red
    exit 1
}

$hits = New-Object System.Collections.ArrayList
foreach ($f in (Get-ChildItem -LiteralPath $Dir -Filter 'licence-*.json' -File -ErrorAction SilentlyContinue)) {
    try {
        $j = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        $p = $j.payload
        if (-not $p) { continue }
        $pm = ([string]$p.machine -replace '\s', '').ToUpperInvariant()
        if ($pm -ne $m) { continue }
        $ed = ([string]$p.edition).ToLowerInvariant()
        if ($ed -ne 'trial' -and $ed -ne 'trial30' -and $ed -ne 'month') { continue }
        [void]$hits.Add([pscustomobject]@{
            Name    = [string]$p.name
            Issued  = [string]$p.issued
            Expires = if ([string]::IsNullOrEmpty([string]$p.expires)) { 'never' } else { [string]$p.expires }
            File    = $f.Name
        })
    } catch { }
}

Write-Host ''
Write-Host ('机器码：' + $m) -ForegroundColor Cyan
Write-Host ('体验版签发记录：' + $hits.Count + ' 次（上限 ' + $Limit + ' 次）')
if ($hits.Count -gt 0) {
    Write-Host ''
    $hits | Sort-Object Issued | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
}
if ($hits.Count -ge $Limit) {
    Write-Host ('[!] 这台机器已经达到上限（' + $hits.Count + '/' + $Limit + '），不建议再卖体验版。') -ForegroundColor Yellow
} else {
    Write-Host ('[OK] 还可以卖 ' + ($Limit - $hits.Count) + ' 次体验版。') -ForegroundColor Green
}
Write-Host ''
