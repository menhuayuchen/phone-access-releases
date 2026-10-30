<#
.SYNOPSIS
    一条命令把新版发到 GitHub Releases：建仓库（如不存在）→ 建 release → 上传安装包

.DESCRIPTION
    目的：发版不再手工点网页。老客户点「检查更新」要能拿到新版，前提就是
    release 里有安装包 asset、tag 是 vX.Y.Z、且是最新正式版（不是 prerelease）。

    需要一枚 GitHub Personal Access Token：
      · classic token：勾 repo 权限
      · fine-grained token：Repository permissions 里给 Contents: Read/Write、
        Administration: Read/Write（建仓库要用），仓库范围选 All repositories 或指定新仓库
    Token 只从 -Token 参数或环境变量 GH_TOKEN 读取，**脚本不打印、不落盘**。

.EXAMPLE
    $env:GH_TOKEN = 'ghp_xxx'     # 只在当前窗口生效，别写进脚本
    .\tools\publish-release.ps1 -Owner yourname -Repo phone-access-releases `
        -AssetPath 'dist\【点这里安装】手机远程-v1.0.7.exe'

.EXAMPLE
    # 预演：只检查 token/仓库/版本，不真的建 release 和上传
    .\tools\publish-release.ps1 -Owner yourname -Repo phone-access-releases `
        -AssetPath 'dist\PhoneAccess-Setup.exe' -DryRun

.NOTES
    UTF-8 with BOM，Windows PowerShell 5.1 可用。不依赖 gh CLI。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Owner,
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$AssetPath,
    # 不填则读 app\product.config.json 的 version
    [string]$Version = '',
    # 更新说明；不填则用一段默认文案
    [string]$NotesPath = '',
    [string]$Token = '',
    [switch]$Private,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Fail([string]$m) { Say ('[x] ' + $m) 'Red'; exit 1 }

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not (Test-Path -LiteralPath $root)) { $root = (Get-Location).Path }

# ---- 1. Token ----
$tok = $Token
if (-not $tok) { $tok = $env:GH_TOKEN }
if (-not $tok) {
    Fail @'
没有 token。两种给法（任选）：
  1) 当前窗口临时设环境变量：$env:GH_TOKEN = 'ghp_xxxx'
  2) 直接传参：-Token 'ghp_xxxx'
Token 在 GitHub → Settings → Developer settings → Personal access tokens 里创建。
'@
}
$headers = @{
    'Authorization'        = ('Bearer ' + $tok)
    'Accept'               = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent'           = 'PhoneAccess-Release-Publisher'
}

function Invoke-Gh {
    param([string]$Method, [string]$Uri, $Body = $null, [string]$ContentType = 'application/json')
    $args = @{ Method = $Method; Uri = $Uri; Headers = $headers; TimeoutSec = 60 }
    if ($null -ne $Body) {
        if ($Body -is [string]) { $args['Body'] = $Body } else { $args['Body'] = ($Body | ConvertTo-Json -Depth 6) }
        $args['ContentType'] = $ContentType
    }
    return Invoke-RestMethod @args
}

# ---- 2. 版本 ----
if (-not $Version) {
    $cfgPath = Join-Path $root 'app\product.config.json'
    if (Test-Path -LiteralPath $cfgPath) {
        $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $Version = [string]$cfg.version
    }
}
if (-not $Version) { Fail '拿不到版本号：请传 -Version，或确认 app\product.config.json 里有 version' }
$tag = 'v' + ($Version -replace '^v', '')
Say ("目标: " + $Owner + '/' + $Repo + '  tag=' + $tag + '  asset=' + (Split-Path -Leaf $AssetPath)) 'Cyan'

# ---- 3. 安装包 ----
if (-not (Test-Path -LiteralPath $AssetPath)) { Fail ('找不到安装包：' + $AssetPath) }
$assetFull = (Resolve-Path -LiteralPath $AssetPath).ProviderPath
$assetName = Split-Path -Leaf $assetFull
$assetSize = [math]::Round((Get-Item -LiteralPath $assetFull).Length / 1MB, 1)
Say ('安装包: ' + $assetName + '  ' + $assetSize + ' MB') 'Gray'
if ($assetSize -gt 2048) { Fail 'GitHub Release 单文件上限 2GB，这个包太大了' }

# ---- 4. 验证 token ----
try {
    $me = Invoke-Gh -Method GET -Uri 'https://api.github.com/user'
} catch {
    Fail ('token 无效或网络不通：' + $_.Exception.Message)
}
Say ('token 属于: ' + $me.login) 'Green'
if ($me.login -ne $Owner) {
    Say ('[!] token 是 ' + $me.login + ' 的，但 Owner 填的是 ' + $Owner + '（组织仓库可忽略）') 'Yellow'
}

# ---- 5. 仓库（不存在就建）----
$repoExists = $true
try {
    $null = Invoke-Gh -Method GET -Uri ('https://api.github.com/repos/' + $Owner + '/' + $Repo)
} catch {
    $repoExists = $false
}
if (-not $repoExists) {
    if ($DryRun) { Say '[dry] 仓库不存在，真实执行时会创建' 'Yellow' }
    else {
        Say '仓库不存在，正在创建…' 'Cyan'
        try {
            $null = Invoke-Gh -Method POST -Uri 'https://api.github.com/user/repos' -Body @{
                name        = $Repo
                private     = [bool]$Private
                description = '手机远程 安装包发布仓库（只放 release 资产，不放源码）'
                auto_init   = $false
            }
        } catch { Fail ('建仓库失败：' + $_.Exception.Message) }
        Say '仓库已创建' 'Green'
    }
} else {
    Say '仓库已存在' 'Gray'
}

# ---- 6. 更新说明 ----
$notes = ''
if ($NotesPath -and (Test-Path -LiteralPath $NotesPath)) {
    $notes = Get-Content -LiteralPath $NotesPath -Raw -Encoding UTF8
}
if (-not $notes) {
    $notes = @"
## v$Version

- 新装 7 天全功能试用（卸载重装不刷新）
- 免费版同时观看最多 3 台设备
- 「检查更新」支持一键下载安装
- 安装前先看免责声明与配置要求
"@
}

# ---- 7. 建 release ----
$relId = $null
$relUrl = $null
try {
    $rel = Invoke-Gh -Method POST -Uri ('https://api.github.com/repos/' + $Owner + '/' + $Repo + '/releases') -Body @{
        tag_name         = $tag
        target_commitish = 'main'
        name             = $tag
        body             = $notes
        draft            = $false
        prerelease       = $false
    }
    $relId = $rel.id
    $relUrl = $rel.html_url
} catch {
    # tag 已存在时 GitHub 返回 422，退回"取已有 release 再传资产"
    try {
        $rel = Invoke-Gh -Method GET -Uri ('https://api.github.com/repos/' + $Owner + '/' + $Repo + '/releases/tags/' + $tag)
        $relId = $rel.id
        $relUrl = $rel.html_url
        Say ('release ' + $tag + ' 已存在，改为补传资产') 'Yellow'
    } catch { Fail ('建 release 失败：' + $_.Exception.Message) }
}
Say ('release: ' + $relUrl) 'Green'

# ---- 8. 上传安装包 ----
if ($DryRun) {
    Say '[dry] 不实际上传，到此为止' 'Yellow'
} else {
    $uploadUri = 'https://uploads.github.com/repos/' + $Owner + '/' + $Repo + '/releases/' + $relId + '/assets?name=' + [uri]::EscapeDataString($assetName)
    Say '正在上传（50MB 左右，按网速可能要几分钟）…' 'Cyan'
    try {
        $up = Invoke-RestMethod -Method POST -Uri $uploadUri -Headers $headers -ContentType 'application/octet-stream' -InFile $assetFull -TimeoutSec 1800
    } catch { Fail ('上传失败：' + $_.Exception.Message) }
    Say ('已上传: ' + $up.browser_download_url) 'Green'
}

# ---- 9. 收尾提示 ----
Say ''
Say '下一步（很重要，别漏）：' 'Cyan'
Say ('  1) 把 app\product.config.json 的 update.github 填成 { "owner": "' + $Owner + '", "repo": "' + $Repo + '" }') 'Gray'
Say '  2) 重新打包（pack.ps1 → build-sfx.ps1），否则客户端的更新源还是空的' 'Gray'
Say '  3) 找一台旧版机器点「检查更新」，确认能看到新版并一键安装' 'Gray'
