<#
.SYNOPSIS
    计算许可证状态，写成 licence.state.json 给画面服务读

.DESCRIPTION
    为什么分两层：密码学（RSA 验签）和机器码（CIM 查询）在 PowerShell 里写起来最省事，
    而画面服务是 Node。所以 PowerShell 算一次 → 写状态文件 → Node 只读结果。
    Node 侧不重复实现任何密码学。

    什么时候调用：
      · start-phone-access.ps1 启动时（算一次）
      · supervise.ps1 每轮守护时（有缓存，很便宜）；客户放好 licence.json 后不用重启就会生效

.NOTES
    UTF-8 with BOM。licence.state.json 本身不带 BOM（Node 的 JSON.parse 不接受 BOM）。
#>
[CmdletBinding()]
param(
    [string]$AppDir = '',
    [switch]$Quiet,
    # 启动时强制重新计算机器码，不吃 machine.id 缓存（独立审查 M1）。
    # 注意：下面的 Test-Licence 早就传了 -ForceMachine:$Force，但此前 param 里没有这个开关，
    # 于是 $Force 恒为 $null -> 永远 $false，M1 那条修复实际上一直没生效。
    [switch]$Force
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $AppDir) { $AppDir = $here }

try { . (Join-Path $here 'licence.ps1') } catch {
    if (-not $Quiet) { Write-Host ('[!] 加载 licence.ps1 失败：' + $_.Exception.Message) -ForegroundColor Yellow }
}

$lic = $null
try { $lic = Test-Licence -AppDir $AppDir -ForceMachine:$Force } catch {
    $lic = [pscustomobject]@{ State = 'error'; Usable = $false; MachineCode = ''; Name = ''; Issued = ''; Expires = ''; Edition = ''; Message = ('校验异常：' + $_.Exception.Message) }
}

# 2026-11-08 删除 7 天试用：trial.ps1 已删除，这里不再 dot-source、也不再计算任何到期状态。

# 读 support 配置（捐赠/购买入口），原样透传给页面
$support = $null
try {
    $cfgPath = Join-Path $AppDir 'product.config.json'
    if (Test-Path -LiteralPath $cfgPath) {
        $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg -and $cfg.support) { $support = $cfg.support }
    }
} catch { }

# brandings 目录里有没有收款码（客户自己丢进去）
$brandingDir = Join-Path $AppDir 'branding'
$qrAlipay = $null; $qrWechat = $null; $contactText = ''
try {
    if (Test-Path -LiteralPath $brandingDir) {
        foreach ($n in @('支付宝.png', 'alipay.png', '支付宝.jpg')) {
            $p = Join-Path $brandingDir $n
            if (Test-Path -LiteralPath $p) { $qrAlipay = '/branding/' + $n; break }
        }
        foreach ($n in @('微信.png', 'wechat.png', '微信.jpg', 'weixin.png')) {
            $p = Join-Path $brandingDir $n
            if (Test-Path -LiteralPath $p) { $qrWechat = '/branding/' + $n; break }
        }
        foreach ($n in @('联系.txt', 'contact.txt')) {
            $p = Join-Path $brandingDir $n
            if (Test-Path -LiteralPath $p) { $contactText = ((Get-Content -LiteralPath $p -Raw -Encoding UTF8) -replace '\s+$', ''); break }
        }
    }
} catch { }

$state = [pscustomobject]@{
    usable      = [bool]$lic.Usable
    # 2026-11-08 删除 7 天试用：产品完全免费，effectiveUsable 恒为 $true（任何功能都不需要许可证）。
    effectiveUsable = $true
    state       = [string]$lic.State
    machineCode = [string]$lic.MachineCode
    # 旧算法机械码（v1，2026-11-03 T2）：screen-server 验许可证时用它兼容老许可证。
    # 两个字段都是空字符串时屏幕服务会回到"没有机器码"的既有行为。
    machineCodeAlt = [string]$lic.LegacyMachineCode
    name        = [string]$lic.Name
    issued      = [string]$lic.Issued
    expires     = [string]$lic.Expires
    edition     = [string]$lic.Edition
    message     = [string]$lic.Message
    checkedAt   = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    support     = $support
    branding    = [pscustomobject]@{ alipay = $qrAlipay; wechat = $qrWechat; contact = $contactText }
}

$outFile = Join-Path $AppDir 'licence.state.json'
try {
    $json = $state | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($outFile, $json, (New-Object System.Text.UTF8Encoding($false)))
} catch {
    if (-not $Quiet) { Write-Host ('[!] 写 licence.state.json 失败：' + $_.Exception.Message) -ForegroundColor Yellow }
}

if (-not $Quiet) {
    if ($lic.Usable) {
        Write-Host ('[i] 许可证：有效（' + $lic.Name + ' / ' + $(if ($lic.Expires -eq 'never' -or -not $lic.Expires) { '永久' } else { $lic.Expires }) + '）') -ForegroundColor Green
    } else {
        Write-Host ('[i] 许可证：' + $lic.Message) -ForegroundColor Cyan
        Write-Host ('    本机机器码：' + $lic.MachineCode)
        # 2026-11-08 删除 7 天试用：产品完全免费，没有许可证也照样全功能，不再说"画面会暂停"。
        Write-Host '    （产品完全免费：没有许可证也能正常使用，机器码只用于换电脑时找回设置）' -ForegroundColor Cyan
    }
}
