# 把 site/ 发布到 GitHub Pages（gh-pages 分支）
#
# 站点地址：https://menhuayuchen.github.io/phone-access-releases/
#   首页        -> site/index.html
#   产品页      -> site/light-screen/index.html   -> /light-screen/
#   关于/授权   -> site/about/index.html          -> /about/
#   视频        -> gh-pages 上的 videos/（本脚本不改它，只保留）
#
# 为什么用临时 worktree：gh-pages 分支里还有 videos/（几十 MB，只存在于该分支），
# 直接在 master 上改再强推会把这些视频冲掉。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File site\deploy-ghpages.ps1            # 预览（只准备，不推）
#   powershell -ExecutionPolicy Bypass -File site\deploy-ghpages.ps1 -Push      # 真正推送
param(
  [switch]$Push,
  [string]$Branch = 'gh-pages',
  [string]$Remote = 'origin'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$siteDir = Join-Path $root 'site'
if (-not (Test-Path (Join-Path $siteDir 'index.html'))) { throw "找不到 $siteDir\index.html" }

# 临时 worktree（放在系统临时目录，避免污染仓库）
$tmp = Join-Path $env:TEMP ('pa-pages-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
Write-Host "[i] 准备 gh-pages 工作区：$tmp" -ForegroundColor Cyan
Push-Location $root
try {
  # 远端已有该分支就检出，没有就新建孤儿分支
  git fetch $Remote $Branch 2>$null | Out-Null
  $hasRemote = $LASTEXITCODE -eq 0
  if ($hasRemote) {
    git worktree add --force $tmp "$Remote/$Branch" | Out-Null
  } else {
    git worktree add --force --detach $tmp | Out-Null
    Push-Location $tmp
    git checkout --orphan $Branch | Out-Null
    Pop-Location
  }
  Write-Host "[i] 工作区就绪（保留 videos/ 等 gh-pages 上已有的内容）" -ForegroundColor Cyan

  # 只覆盖站点文件，不动 videos/
  Copy-Item (Join-Path $siteDir 'index.html') $tmp -Force
  Copy-Item (Join-Path $siteDir 'theme.css') $tmp -Force
  foreach ($sub in @('light-screen', 'about')) {
    $dst = Join-Path $tmp $sub
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
    Copy-Item (Join-Path $siteDir "$sub\*") $dst -Recurse -Force
  }
  # 根目录也放一份协议，方便直接访问 /LICENSE.txt
  $lic = Join-Path $root 'LICENSE'
  if (Test-Path $lic) { Copy-Item $lic (Join-Path $tmp 'LICENSE.txt') -Force }

  Push-Location $tmp
  git add -A
  $status = git status --porcelain
  if (-not $status) {
    Write-Host "[i] 站点内容没有变化，无需提交" -ForegroundColor Yellow
  } else {
    $msg = "site: 轻器/轻屏 站点改版 ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))"
    git -c user.name='qingqi-site' -c user.email='qingqi@local' commit -q -m $msg
    Write-Host "[✓] 已提交：$msg" -ForegroundColor Green
    if ($Push) {
      git push $Remote "HEAD:$Branch"
      Write-Host "[✓] 已推送到 $Remote/$Branch（GitHub Pages 会在 1-2 分钟内更新）" -ForegroundColor Green
      Write-Host "    站点：https://menhuayuchen.github.io/phone-access-releases/" -ForegroundColor Cyan
    } else {
      Write-Host "[i] 预览模式：没有推送。确认没问题后加 -Push 再跑一次。" -ForegroundColor Yellow
    }
  }
  Pop-Location
} finally {
  Push-Location $root
  git worktree remove --force $tmp 2>$null | Out-Null
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  Pop-Location
}
