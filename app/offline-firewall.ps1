param(
    [ValidateSet('on', 'off')]
    [string]$Action = 'on'
)
# 离线模式的防火墙：默认安装时「拒绝局域网私有网段」的规则会挡住手机（局域网/热点/USB 直连）。
#   -Action on  ：停用拒绝规则，放行产品端口（TCP）和 rtc-h264.exe（UDP，WebRTC 媒体）来自私有网段
#   -Action off ：删除放行规则，恢复拒绝规则
# 需要管理员权限（安装器/离线入口会用 Start-Process -Verb RunAs 调用）。
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'product-config.ps1')
$cfg = Get-ProductConfig -AppDir $here
$ports = @([int]$cfg.ports.screen, ([int]$cfg.ports.screen + 1))   # +1 = 局域网 http 备用
$tag = 'PhoneAccess 手机远程'
$lanRanges = @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')

foreach ($p in $ports) {
    $blockName = $tag + ' : 拒绝局域网 ' + [string]$p
    $allowLanName = $tag + ' : 离线模式允许局域网 ' + [string]$p
    if ($Action -eq 'on') {
        Get-NetFirewallRule -DisplayName $blockName -ErrorAction SilentlyContinue | Set-NetFirewallRule -Enabled False -ErrorAction SilentlyContinue
        Get-NetFirewallRule -DisplayName $allowLanName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
        $null = New-NetFirewallRule -DisplayName $allowLanName -Direction Inbound -Action Allow -Protocol TCP `
            -LocalPort $p -RemoteAddress $lanRanges -Profile Any -ErrorAction SilentlyContinue `
            -Description '手机远程：离线模式放行局域网/热点/USB 直连'
    } else {
        Get-NetFirewallRule -DisplayName $allowLanName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
        Get-NetFirewallRule -DisplayName $blockName -ErrorAction SilentlyContinue | Set-NetFirewallRule -Enabled True -ErrorAction SilentlyContinue
    }
}

# WebRTC 媒体走 UDP 动态端口，只能按程序放行
$exe = Join-Path $here 'rtc-h264\rtc-h264.exe'
$progName = $tag + ' : 离线模式允许局域网 WebRTC'
Get-NetFirewallRule -DisplayName $progName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
if ($Action -eq 'on' -and (Test-Path -LiteralPath $exe)) {
    $null = New-NetFirewallRule -DisplayName $progName -Direction Inbound -Action Allow -Protocol UDP `
        -Program $exe -RemoteAddress $lanRanges -Profile Any -ErrorAction SilentlyContinue `
        -Description '手机远程：离线模式 WebRTC H.264 媒体（UDP）'
}

# 验证是否真的生效（非管理员时 New-NetFirewallRule 会静默失败）
$applied = $false
try { $applied = [bool](Get-NetFirewallRule -DisplayName ($tag + ' : 离线模式允许局域网 ' + [string]$ports[0]) -ErrorAction SilentlyContinue) } catch { }
if ($Action -eq 'on' -and -not $applied) {
    Write-Output '{"ok":false,"error":"需要管理员权限（请在弹出的窗口点「是」）"}'
    exit 1
}
Write-Output ('{"ok":true,"action":"' + $Action + '"}')
