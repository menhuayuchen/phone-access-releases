<#
让手机端 DSH 只能从 Tailscale 进，局域网（校园 Wi-Fi / 宿舍路由器）进不来。
需要的管理员权限，所以这个脚本必须"以管理员身份运行"。

背景（2026-10-26 实测）：
  - 防火墙里有一条 "DSH Web (phone access) 8642"，Action=Allow、Profile=Any
  - node.exe 还有两条 Profile=Private,Public 的放行
  - 当前 WLAN 是 CUP-WLAN 2，类别 = Public
  => 同校园网段的人可以直接连 10.120.169.250:8642（DSH）和 :8660（画面/输入服务）

这个脚本做的事：
  1. 关掉那条 Profile=Any 的宽放行
  2. 对 8642 和 8660 各建两条规则：
     允许 100.64.0.0/10（Tailscale 的地址段）
     拒绝 10/8、172.16/12、192.168/16（所有局域网私有段）
     Windows 防火墙里 Block 优先于 Allow，所以即使 node.exe 的宽放行还在也不会漏
  3. 本机 127.0.0.1 完全不受影响（本地回环不过防火墙）

撤销：.\harden-firewall.ps1 -Undo

注意：跑完之后，手机上"同一 Wi-Fi 更快"的局域网链接会连不上，必须用 Tailscale 地址：
  http://100.108.92.22:8642/go?k=<屏幕密钥>
Tailscale 在同一个 Wi-Fi 下也是直连（不经中转），速度不会比局域网差。
#>
param([switch]$Undo)

$ErrorActionPreference = 'Stop'
$TAG = 'DSH phone access'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host '需要管理员权限：右键这个文件 →「使用 PowerShell 运行」，或先在管理员 PowerShell 里执行。' -ForegroundColor Red
  exit 1
}

if ($Undo) {
  Get-NetFirewallRule -DisplayName "$TAG*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  Get-NetFirewallRule -DisplayName 'DSH Web (phone access) 8642' -ErrorAction SilentlyContinue | Enable-NetFirewallRule -ErrorAction SilentlyContinue
  Write-Host '已撤销：局域网访问恢复，8642 的宽放行重新启用。' -ForegroundColor Yellow
  exit 0
}

# 1) 关掉 Profile=Any 的宽放行
$wide = Get-NetFirewallRule -DisplayName 'DSH Web (phone access) 8642' -ErrorAction SilentlyContinue
if ($wide) {
  $wide | Disable-NetFirewallRule -ErrorAction SilentlyContinue
  Write-Host "已停用宽放行规则：$($wide.DisplayName)"
} else {
  Write-Host '没找到那条宽放行规则（可能已改名），继续。'
}

# 2) 端口级：只放 Tailscale 段，拒所有私有网段
$LAN_RANGES = @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')
$TAILNET = '100.64.0.0/10'

foreach ($port in 8642, 8660) {
  $allowName = "$TAG : tailnet only $port"
  $blockName = "$TAG : block lan $port"

  Get-NetFirewallRule -DisplayName $allowName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName $allowName -Direction Inbound -Action Allow -Protocol TCP `
    -LocalPort $port -RemoteAddress $TAILNET -Profile Any -Description 'Agent 手机入口：只允许 Tailscale 段' | Out-Null

  Get-NetFirewallRule -DisplayName $blockName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName $blockName -Direction Inbound -Action Block -Protocol TCP `
    -LocalPort $port -RemoteAddress $LAN_RANGES -Profile Any -Description 'Agent 手机入口：拒绝局域网私有段' | Out-Null

  Write-Host "端口 $port : 允许 $TAILNET / 拒绝 $($LAN_RANGES -join ', ')"
}

Write-Host ''
Write-Host '完成。现在的效果：' -ForegroundColor Green
Write-Host '  127.0.0.1       照常（本机）'
Write-Host '  Tailscale 段    照常（手机用 http://100.108.92.22:8642/go?k=...）'
Write-Host '  校园/家庭局域网 被拒绝'
Write-Host ''
Write-Host '验证（在手机上）：局域网链接应打不开、Tailscale 链接应正常。'
Write-Host '想恢复：.\harden-firewall.ps1 -Undo'