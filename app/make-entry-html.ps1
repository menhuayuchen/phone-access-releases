# make-entry-html.ps1 - 生成「手机入口」单页，替代安装完成后弹出来的一堆窗口
#
# 背景（2026-11-09 用户反馈）：安装完成后安装器会
#   ① 打开图片查看器看二维码  ② 打开记事本看网址  ③ 兜底打开资源管理器
# 客户一次看到好几个窗口，乱且不好看。这里把它们合并成一个本地 HTML 页面，
# 用默认浏览器打开一次就够了：二维码、网址、机器码、接下来要做的三步都在同一页里。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File make-entry-html.ps1 `
#       -InstallRoot "C:\Users\x\AppData\Local\PhoneAccess" [-Open]
#
# 输出：<InstallRoot>\手机入口.html
# 说明：二维码以 base64 内嵌，页面可以单独拷走/离线打开；不含任何密钥以外的隐私信息。
#       本文件必须 UTF-8 with BOM（PowerShell 5.1）。

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [string]$OutPath = '',
    [string]$Title = '轻屏 · 手机入口',
    [switch]$Open
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function HtmlEnc([string]$s) {
    if ($null -eq $s) { return '' }
    return $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
}

$qrPath = Join-Path $InstallRoot 'screen-qr.png'
$urlFilePath = Join-Path $InstallRoot 'screen-url.txt'
$statePath = Join-Path $InstallRoot 'licence.state.json'

# 二维码 → base64（页面自包含，不依赖外部文件）
$qrB64 = ''
if (Test-Path -LiteralPath $qrPath) {
    try { $qrB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($qrPath)) } catch { $qrB64 = '' }
}

# 网址（可能有多行：优先 tailnet 域名，其次内网 IP）
$urls = @()
if (Test-Path -LiteralPath $urlFilePath) {
    try {
        $urls = @(Get-Content -LiteralPath $urlFilePath -Encoding UTF8 | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
    } catch { $urls = @() }
}

# 机器码（未授权时客户要把这串发给卖家）
$machineCode = ''
try {
    if (Test-Path -LiteralPath $statePath) {
        $st = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($st -and $st.machineCode) { $machineCode = [string]$st.machineCode }
    }
} catch { }

$licenseOk = $false
$licenseName = ''
try {
    if (Test-Path -LiteralPath $statePath) {
        $st2 = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($st2 -and $st2.usable) { $licenseOk = $true; $licenseName = [string]$st2.name }
    }
} catch { }

if (-not $OutPath) { $OutPath = Join-Path $InstallRoot '手机入口.html' }

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('<!DOCTYPE html>')
[void]$sb.AppendLine('<html lang="zh-CN"><head><meta charset="utf-8">')
[void]$sb.AppendLine('<meta name="viewport" content="width=device-width,initial-scale=1">')
[void]$sb.AppendLine('<title>' + (HtmlEnc $Title) + '</title>')
[void]$sb.AppendLine(@'
<style>
:root{--bg:#0d0f13;--card:#171a21;--line:#262a33;--tx:#e8eaee;--tx2:#a8b0ba;--accent:#35d6c4;--warn:#ffb454}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.7 "Microsoft YaHei UI","Segoe UI",system-ui,sans-serif;
     display:flex;justify-content:center;padding:28px 16px}
.wrap{width:100%;max-width:720px}
h1{font-size:22px;margin:0 0 4px}
.sub{color:var(--tx2);font-size:13px;margin-bottom:22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:14px}
.card h2{font-size:15px;margin:0 0 12px;color:var(--accent)}
.qr{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
.qr img{width:200px;height:200px;background:#fff;border-radius:10px;padding:6px;image-rendering:pixelated}
.urlbox{flex:1;min-width:240px}
.url{display:block;background:#0f1116;border:1px solid var(--line);border-radius:8px;padding:9px 11px;
     margin-bottom:8px;font:12.5px/1.5 ui-monospace,Consolas,monospace;color:#cfe9e4;word-break:break-all;text-decoration:none}
.url:hover{border-color:var(--accent)}
ol{margin:0;padding-left:20px}
ol li{margin-bottom:9px}
.badge{display:inline-block;padding:2px 9px;border-radius:20px;font-size:12px;border:1px solid}
.ok{color:#8CE58C;border-color:#2a6b3a;background:rgba(42,107,58,.18)}
.warn{color:var(--warn);border-color:#6b5320;background:rgba(107,83,32,.18)}
.code{font:13px/1.6 ui-monospace,Consolas,monospace;background:#0f1116;border:1px dashed #3a3e4a;
      border-radius:8px;padding:10px 12px;word-break:break-all;color:#ffd9a0;user-select:all}
.tip{color:var(--tx2);font-size:12.5px}
.foot{color:#5f666f;font-size:12px;text-align:center;margin-top:18px}
</style></head><body><div class="wrap">
'@)
[void]$sb.AppendLine('<h1>' + (HtmlEnc $Title) + '</h1>')
[void]$sb.AppendLine('<div class="sub">安装已完成。这一页把所有要用的东西放在一起，看完可以直接关掉。</div>')

# --- 卡片 1：手机扫码 ---
[void]$sb.AppendLine('<div class="card"><h2>① 用手机扫码（手机要先连上 Tailscale）</h2><div class="qr">')
if ($qrB64) {
    [void]$sb.AppendLine('<img alt="手机入口二维码" src="data:image/png;base64,' + $qrB64 + '">')
} else {
    [void]$sb.AppendLine('<div style="width:200px;height:200px;display:flex;align-items:center;justify-content:center;' +
        'background:#0f1116;border:1px dashed #3a3e4a;border-radius:10px;color:#5f666f;font-size:12.5px;text-align:center">' +
        '二维码还没生成<br>等几秒后刷新</div>')
}
[void]$sb.AppendLine('<div class="urlbox">')
if ($urls.Count -gt 0) {
    foreach ($u in $urls) {
        [void]$sb.AppendLine('<a class="url" href="' + (HtmlEnc $u) + '" target="_blank" rel="noreferrer">' + (HtmlEnc $u) + '</a>')
    }
    [void]$sb.AppendLine('<div class="tip">点上面的地址也能打开（电脑上先试试，能打开说明服务正常）。地址里带密钥，别截图发给别人。</div>')
} else {
    [void]$sb.AppendLine('<div class="tip">入口文件还没生成。等几秒，或双击桌面「轻屏」文件夹里的「手机入口」重新生成。</div>')
}
[void]$sb.AppendLine('</div></div></div>')

# --- 卡片 2：接下来要做的三步 ---
[void]$sb.AppendLine('<div class="card"><h2>② 还要做这三件事</h2><ol>')
[void]$sb.AppendLine('<li>手机上装 <b>Tailscale</b> 并登录<b>同一个账号</b>（不装的话手机连不上这台电脑）。</li>')
[void]$sb.AppendLine('<li>关掉电脑自动睡眠：<b>设置 → 系统 → 电源 → 屏幕和睡眠</b>，两个都选「从不」。否则电脑睡了手机就连不上。</li>')
[void]$sb.AppendLine('<li>用手机扫上面的二维码，确认<b>能看到画面、点得动、能打字</b>。然后<b>重启一次电脑</b>，再连一次——重启后还能连，才算真的装好。</li>')
[void]$sb.AppendLine('</ol></div>')

# --- 卡片 3：许可证 ---
[void]$sb.AppendLine('<div class="card"><h2>③ 授权</h2>')
if ($licenseOk) {
    $who = if ($licenseName) { '（' + (HtmlEnc $licenseName) + '）' } else { '' }
    [void]$sb.AppendLine('<span class="badge ok">已授权' + $who + '</span>')
    [void]$sb.AppendLine('<div class="tip" style="margin-top:10px">许可证已装好，可以正常使用。</div>')
} else {
    [void]$sb.AppendLine('<span class="badge warn">未授权</span>')
    if ($machineCode) {
        [void]$sb.AppendLine('<div class="tip" style="margin-top:12px;margin-bottom:6px">把下面这串<b>机器码</b>发给卖家，换一份许可证文件：</div>')
        [void]$sb.AppendLine('<div class="code">' + (HtmlEnc $machineCode) + '</div>')
        [void]$sb.AppendLine('<div class="tip" style="margin-top:8px">拿到 <b>licence.json</b> 后放进这个目录，几秒内自动生效，不用重启：<br>' +
            '<span style="color:#cfe9e4;word-break:break-all">' + (HtmlEnc $InstallRoot) + '</span></div>')
    } else {
        [void]$sb.AppendLine('<div class="tip" style="margin-top:10px">机器码没算出来。双击桌面「轻屏」文件夹里的「自查」可以看到。</div>')
    }
    [void]$sb.AppendLine('<div class="tip" style="margin-top:8px">在放好许可证之前，手机能打开网页，但画面和操作是暂停的。</div>')
}
[void]$sb.AppendLine('</div>')

# --- 卡片 4：出问题怎么办 ---
[void]$sb.AppendLine('<div class="card"><h2>出问题怎么办</h2><div class="tip">双击桌面「轻屏」文件夹里的「<b>自查</b>」，' +
    '它会生成一份报告，把这个报告文件发给卖家即可。桌面「轻屏」文件夹里还有：启动 / 停止 / 手机入口 / 离线模式。</div></div>')

[void]$sb.AppendLine('<div class="foot">本页面可以直接关掉。以后要再看一遍：双击桌面「轻屏」文件夹里的「手机入口」。</div>')
[void]$sb.AppendLine('</div></body></html>')

try {
    $dir = Split-Path -Parent $OutPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { $null = New-Item -ItemType Directory -Path $dir -Force }
    [IO.File]::WriteAllText($OutPath, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
} catch {
    Write-Error ('生成手机入口页面失败：' + $_.Exception.Message)
    exit 1
}

Write-Host ('[OK] 已生成：' + $OutPath)

if ($Open) {
    try { $null = Start-Process -FilePath $OutPath } catch {
        try { $null = Start-Process -FilePath 'msedge.exe' -ArgumentList ('"' + $OutPath + '"') } catch { }
    }
}
exit 0
