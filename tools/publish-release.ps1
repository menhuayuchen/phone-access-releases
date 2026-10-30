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
    # token 文件：tools\set-github-token.ps1 写入的位置。没传 -Token、也没有 GH_TOKEN 时读它。
    [string]$TokenFile = (Join-Path $env:USERPROFILE '.gh-token'),
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
if (-not $tok -and (Test-Path -LiteralPath $TokenFile)) {
    $tok = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
}
if (-not $tok) {
    Fail @'
没有 token。三种给法（任选）：
  1) 推荐：双击 tools\设置GitHub令牌.cmd（等同于 tools\set-github-token.ps1），
     粘贴后它会先验证再存到 %USERPROFILE%\.gh-token，本脚本以后自动读取；
  2) 当前窗口临时设环境变量：$env:GH_TOKEN = 'ghp_xxxx'
  3) 直接传参：-Token 'ghp_xxxx'
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

# GitHub 会把非 ASCII 的 asset 名清洗掉（实测"【点这里安装】手机远程-v1.0.6.exe" 变成 "-v1.0.6.exe"）。
# 客户端挑安装包有兜底，但下载链接和文件名对客户太丑，所以上传一律用 ASCII 名；本地文件保持中文名。
$uploadName = $assetName
if ($uploadName -match '[^\x20-\x7E]') { $uploadName = 'PhoneAccess-Setup-' + $tag + '.exe' }
if ($uploadName -ne $assetName) { Say ('上传用的文件名: ' + $uploadName + '（ASCII，避免被 GitHub 洗掉）') 'Gray' }

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

function New-Release {
    Invoke-Gh -Method POST -Uri ('https://api.github.com/repos/' + $Owner + '/' + $Repo + '/releases') -Body @{
        tag_name   = $tag
        # 刻意不传 target_commitish：空仓库里它指向的分支不存在，GitHub 会用 404 冒充权限问题
        # （2026-10-30 实测：真正的报错是 404 "Not Found"，排查时差点误判成 token 权限不足）。
        name       = $tag
        body       = $notes
        draft      = $false
        prerelease = $false
    }
}

try {
    $rel = New-Release
    $relId = $rel.id
    $relUrl = $rel.html_url
} catch {
    # 两种常见失败：
    #   · 仓库是空的（没有 commit）→ 建不了 tag，返回 422/404
    #     → 先提交一个 README 把 main 分支建出来，再重试一次
    #   · tag 已存在 → 退回"取已有 release 再补传资产"
    $initialized = $false
    try {
        $probe = Invoke-Gh -Method GET -Uri ('https://api.github.com/repos/' + $Owner + '/' + $Repo)
        $empty = ([int]$probe.size -eq 0)
    } catch { $empty = $false }

    if ($empty -and -not $DryRun) {
        Say '仓库还是空的（没有任何 commit），先初始化 README…' 'Yellow'
        $readme = "# 手机远程 · 安装包发布仓库`n`n这里只放发布出来的安装包（Release 附件），不放源码、许可证、私钥。`n"
        $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($readme))
        try {
            $null = Invoke-Gh -Method PUT -Uri ('https://api.github.com/repos/' + $Owner + '/' + $Repo + '/contents/README.md') -Body @{
                message = 'init: 初始化仓库（release 至少需要一个 commit 才能建 tag）'
                content = $b64
            }
            $initialized = $true
            Say 'README 已提交，重试建 release…' 'Gray'
        } catch { Say ('初始化 README 失败：' + $_.Exception.Message) 'Yellow' }
    }

    $done = $false
    if ($initialized) {
        try {
            $rel = New-Release
            $relId = $rel.id
            $relUrl = $rel.html_url
            $done = $true
        } catch { }
    }
    if (-not $done) {
        try {
            $rel = Invoke-Gh -Method GET -Uri ('https://api.github.com/repos/' + $Owner + '/' + $Repo + '/releases/tags/' + $tag)
            $relId = $rel.id
            $relUrl = $rel.html_url
            Say ('release ' + $tag + ' 已存在，改为补传资产') 'Yellow'
        } catch { Fail ('建 release 失败：' + $_.Exception.Message) }
    }
}
Say ('release: ' + $relUrl) 'Green'

# ---- 8. 上传安装包 ----
if ($DryRun) {
    Say '[dry] 不实际上传，到此为止' 'Yellow'
} else {
    $uploadUri = 'https://uploads.github.com/repos/' + $Owner + '/' + $Repo + '/releases/' + $relId + '/assets?name=' + [uri]::EscapeDataString($uploadName)
    Say '正在上传（50MB 左右，按网速可能要几分钟）…' 'Cyan'
    try {
        $up = Invoke-RestMethod -Method POST -Uri $uploadUri -Headers $headers -ContentType 'application/octet-stream' -InFile $assetFull -TimeoutSec 1800
    } catch { Fail ('上传失败：' + $_.Exception.Message) }
    Say ('已上传: ' + $up.browser_download_url) 'Green'
}

# ---- 9. 收尾提示 ----
Say ''
Say '下一步：' 'Cyan'
# 更新源是否已经指向这个仓库（已经指向就不再啰嗦）
$cfgNow = $null
$cfgPath2 = Join-Path $root 'app\product.config.json'
if (Test-Path -LiteralPath $cfgPath2) { try { $cfgNow = Get-Content -LiteralPath $cfgPath2 -Raw -Encoding UTF8 | ConvertFrom-Json } catch { } }
$ghNow = $null
if ($cfgNow -and $cfgNow.update -and $cfgNow.update.github) { $ghNow = $cfgNow.update.github }
if ($ghNow -and $ghNow.owner -eq $Owner -and $ghNow.repo -eq $Repo) {
    Say ('  [OK] update.github 已经指向 ' + $Owner + '/' + $Repo + '，打包时不用再改') 'Green'
} else {
    Say ('  1) 把 app\product.config.json 的 update.github 填成 { "owner": "' + $Owner + '", "repo": "' + $Repo + '" }') 'Gray'
}
Say '  2) 重新打包（pack.ps1 → build-sfx.ps1），否则客户端的更新源还是空的' 'Gray'
Say '  3) 找一台旧版机器点「检查更新」，确认能看到新版并一键安装' 'Gray'
