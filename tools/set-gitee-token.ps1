<#
.SYNOPSIS
    保存 Gitee 私人令牌到 %USERPROFILE%\.gitee-token（不回显、不进仓库）

.DESCRIPTION
    为什么要这个文件：
      · 发版脚本 tools\publish-gitee-release.mjs 从这里读令牌，把安装包传到 Gitee 发行版，
        这样国内客户/自动更新可以走 Gitee 的直链（实测 ~1.4MB/s，GitHub 只有 ~25KB/s）。
      · 令牌只存在你自己电脑的这个文件里；脚本、日志、git 都不会包含它。

    令牌怎么建（2026-10 页面）：
      1) 打开 https://gitee.com/profile/personal_access_tokens
      2) 「生成新令牌」→ 名称随便（如 phone-access-publish）
      3) 权限勾选：**projects**（仓库读写）、**user_info**（用于校验账号）
      4) 生成后复制那一串，运行本脚本粘贴进来（输入不回显）

    用法：
      双击 tools\设置Gitee令牌.cmd
      或 powershell -NoProfile -ExecutionPolicy Bypass -File tools\set-gitee-token.ps1
      只校验已保存的令牌：... -CheckOnly

.NOTES
    UTF-8 with BOM，PS 5.1。
#>
param(
    [string]$Token = '',
    [switch]$CheckOnly,
    [string]$TokenFile = (Join-Path $env:USERPROFILE '.gitee-token')
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

function Fail([string]$m) {
    Write-Host ('[x] ' + $m) -ForegroundColor Red
    exit 1
}

function Test-GiteeToken([string]$tok) {
    # 用 /user 校验令牌；成功返回登录名，失败返回 $null
    try {
        $u = 'https://gitee.com/api/v5/user?access_token=' + [uri]::EscapeDataString($tok)
        $r = Invoke-RestMethod -Uri $u -Headers @{ 'User-Agent' = 'PhoneAccess-Gitee-Token' } -TimeoutSec 25
        if ($r -and $r.login) { return [string]$r.login }
        return $null
    } catch {
        return $null
    }
}

if ($CheckOnly) {
    if (-not (Test-Path -LiteralPath $TokenFile)) { Fail ('没有令牌文件：' + $TokenFile) }
    $tok = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
    if (-not $tok) { Fail '令牌文件是空的' }
    $login = Test-GiteeToken $tok
    if (-not $login) { Fail '令牌无效/已过期，或权限里没有 user_info' }
    Write-Host ('[OK] 令牌有效，账号：' + $login) -ForegroundColor Green
    exit 0
}

if (-not $Token) {
    Write-Host ''
    Write-Host '把 Gitee 私人令牌粘贴到下面（输入不回显），回车确认：' -ForegroundColor Cyan
    $sec = Read-Host -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
$Token = ([string]$Token).Trim()
if (-not $Token) { Fail '没拿到令牌' }

$login = Test-GiteeToken $Token
if (-not $login) {
    Fail '令牌校验失败：可能已过期，或权限里没勾 projects / user_info。重建一个再试。'
}

[System.IO.File]::WriteAllText($TokenFile, $Token, (New-Object System.Text.UTF8Encoding($false)))
try {
    # 只留当前用户可读写（失败不影响使用）
    icacls $TokenFile /inheritance:r /grant:r ("$($env:USERNAME):(R,W)") 1>$null 2>$null
} catch { }

Write-Host ''
Write-Host ('[OK] 已保存到 ' + $TokenFile + '（账号：' + $login + '）') -ForegroundColor Green
Write-Host '     这个文件不要发给别人、不要提交进 git。以后发版脚本会自动读它。'
Write-Host ''
