<#
.SYNOPSIS
    安全地把 GitHub token 存到本机（供 publish-release.ps1 使用）

.DESCRIPTION
    为什么要有这个脚本：
      · token 不该贴在聊天里、不该写进代码，也不该留在命令历史里；
      · 双击本脚本 → 弹一句提示 → 粘贴 token（输入时不显示）→ 现场验证 → 存成一个文件；
      · 文件权限收紧到"只有当前用户能读写"，并去掉继承权限。

    用法：
      · 双击 tools\设置GitHub令牌.cmd（推荐，不用记命令）
      · 或手动：.\tools\set-github-token.ps1
      · 只检查已有文件是否有效：.\tools\set-github-token.ps1 -CheckOnly

    存到了哪里：%USERPROFILE%\.gh-token（默认，一行文本，无 BOM）
    怎么用：publish-release.ps1 会自动读这个路径，也可以显式传 -TokenFile。

.NOTES
    UTF-8 with BOM，Windows PowerShell 5.1。
#>
[CmdletBinding()]
param(
    [string]$Path = (Join-Path $env:USERPROFILE '.gh-token'),
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }

function Test-Token([string]$tok) {
    $h = @{
        'Authorization'        = 'Bearer ' + $tok
        'Accept'               = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent'           = 'PhoneAccess-Setup'
    }
    return Invoke-RestMethod -Method GET -Uri 'https://api.github.com/user' -Headers $h -TimeoutSec 30
}

# ---- 只检查模式 ----
if ($CheckOnly) {
    if (-not (Test-Path -LiteralPath $Path)) { Say ('[x] 还没存过 token：' + $Path) 'Red'; exit 1 }
    $tok = (Get-Content -LiteralPath $Path -Raw).Trim()
    try {
        $me = Test-Token $tok
        Say ('[i] token 有效，属于 ' + $me.login) 'Green'
        exit 0
    } catch {
        Say ('[x] token 无效或已过期：' + $_.Exception.Message) 'Red'
        exit 1
    }
}

# ---- 交互输入 ----
Say ''
Say '  手机远程 · GitHub 令牌设置' 'Cyan'
Say '  ------------------------------------------------------------' 'DarkGray'
Say '  1) 打开 https://github.com/settings/tokens/new' 'Gray'
Say '  2) Note 随便填（例如 phone-access-release），Expiration 选 90 days 或 No expiration' 'Gray'
Say '  3) 勾选 scope：repo（fine-grained token 则给 Contents: Read/Write + Administration: Read/Write）' 'Gray'
Say '  4) 点 Generate token，复制那串 ghp_... （只显示一次）' 'Gray'
Say '  5) 回到这个窗口，右键粘贴到下面这行，回车' 'Gray'
Say '  ------------------------------------------------------------' 'DarkGray'
Say ''

$sec = Read-Host -Prompt '  粘贴 token（输入时不显示）' -AsSecureString
if (-not $sec) { Say '[x] 没有输入，已退出' 'Red'; exit 1 }

$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { $tok = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
$tok = ($tok -replace '\s', '')
if (-not $tok) { Say '[x] 读到的是空 token，已退出' 'Red'; exit 1 }
if ($tok.Length -lt 20) { Say '[x] token 太短，可能没粘全' 'Red'; exit 1 }

# ---- 现场验证（验证通过才落盘，避免存一个错 token 以后排查半天）----
Say '  正在验证…' 'DarkGray'
try {
    $me = Test-Token $tok
} catch {
    Say ('[x] 验证失败：' + $_.Exception.Message) 'Red'
    Say '    常见原因：token 粘漏字符、已过期、或网络访问不了 api.github.com' 'Yellow'
    exit 1
}

# ---- 落盘 + 收紧权限 ----
$dir = Split-Path -Parent $Path
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
[System.IO.File]::WriteAllText($Path, $tok, (New-Object System.Text.UTF8Encoding($false)))

try {
    # 去掉继承并只给当前用户完全控制（失败不算错：某些机器上 icacls 会被策略拦）
    $null = & icacls $Path /inheritance:r 2>&1
    $who = $env:USERDOMAIN + '\' + $env:USERNAME
    $null = & icacls $Path /grant:r ($who + ':F') 2>&1
} catch { }

Say ''
Say ('[√] 已保存到 ' + $Path) 'Green'
Say ('    token 属于：' + $me.login) 'Green'
Say '    现在可以让 Agent 跑 tools\publish-release.ps1 了。' 'Gray'
Say ''
