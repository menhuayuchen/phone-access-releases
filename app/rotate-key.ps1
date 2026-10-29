<#
换访问密钥（= 立刻吊销所有旧链接和所有已登录设备）。

什么时候用：
  - 觉得密钥可能泄漏了（发给过别人、截图、公共电脑上看过）
  - 手机丢了 / 卖掉了
  - 想给所有设备重新授权一遍

换完之后：
  - 旧的 /go?k=... 链接立刻失效
  - 所有已种下的 dshk cookie（自动登录用的）立刻失效，因为它是密钥的 sha256
  - 二维码与链接文件会重新生成（复用 start-phone-access.ps1，不改任何代码）
  - 已经在用的 DSH 会话 cookie（30 天那个）不受影响，所以当前页面不会掉线

用法：
  .\rotate-key.ps1 -Force       真换（-Force 是防止误触）
  .\rotate-key.ps1              只提示，不动
#>
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$keyFile = Join-Path $here 'screen.key'

if (-not (Test-Path $keyFile)) { Write-Host "找不到 $keyFile" -ForegroundColor Red; exit 1 }

if (-not $Force) {
  $cur = (Get-Content $keyFile -Raw).Trim()
  Write-Host "当前密钥：$($cur.Substring(0,4))…（$($cur.Length) 位）"
  Write-Host '要真换，加 -Force 再执行一次。'
  exit 0
}

# 16 字节 = 128 bit，比原来的 64 bit 强一倍（原来是 16 位十六进制）
$bytes = New-Object byte[] 16
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$new = -join ($bytes | ForEach-Object { $_.ToString('x2') })

$old = (Get-Content $keyFile -Raw).Trim()
Set-Content -Path $keyFile -Value $new -Encoding ascii
Write-Host "密钥已更换：$($old.Substring(0,4))… → $($new.Substring(0,4))…  （$($new.Length) 位，128 bit）"

# 重新生成 URL / 二维码（start-phone-access.ps1 里的那段逻辑会按新 key 写文件）
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'start-phone-access.ps1') -Quiet 2>&1 |
  Select-Object -Last 18 | ForEach-Object { "  $_" }

Write-Host ''
Write-Host '新的长期入口（旧链接已全部失效）：' -ForegroundColor Green
$login = Join-Path $here 'login-url.txt'
if (Test-Path $login) { Write-Host ("  {0}" -f (Get-Content $login -Raw).Trim()) }
else { Write-Host ("  http://100.108.92.22:8642/go?k=" + $new) }