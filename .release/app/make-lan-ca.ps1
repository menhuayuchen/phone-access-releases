param(
    [string]$OutDir = '',
    [string]$DnsName = ''
)
# 本地 CA + 服务端叶子证书（局域网 https 用）。
#   lan-ca.crt      根证书（DER，给手机安装；装一次以后永久受信任，可安装成 App、没有证书警告）
#   lan-server.pfx  叶子证书（SAN = 当前所有局域网 IP + localhost，PFX 带密码）
#   lan-cert.pass   PFX 密码（服务端读它来加载证书）
# 用 Windows 证书存储生成/签名：.NET Framework 的 CertificateRequest 导不出带私钥的 PFX（实测会丢私钥），
# 而 New-SelfSignedCertificate + Export-PfxCertificate 走的是 CSP/存储，导出可靠。
# CA 私钥保存在当前用户证书存储（CurrentUser\My），重装/换 IP 只重签叶子，手机不用重装 CA。
$ErrorActionPreference = 'Stop'
if (-not $OutDir) { $OutDir = $PSScriptRoot }
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$passFile = Join-Path $OutDir 'lan-cert.pass'
$caCrtPath = Join-Path $OutDir 'lan-ca.crt'
$leafPath = Join-Path $OutDir 'lan-server.pfx'

# 1) PFX 密码（首次生成后复用）
$pass = ''
if (Test-Path -LiteralPath $passFile) {
    try { $pass = (Get-Content -LiteralPath $passFile -Raw -Encoding UTF8).Trim() } catch { $pass = '' }
}
if (-not $pass -or $pass.Length -lt 8) {
    $pass = [guid]::NewGuid().ToString('N').Substring(0, 24)
    [System.IO.File]::WriteAllText($passFile, $pass, (New-Object System.Text.UTF8Encoding($false)))
}
$sec = ConvertTo-SecureString -String $pass -AsPlainText -Force

# 2) 根 CA（存在就复用，10 年有效）
$caSubject = 'CN=PhoneAccess Local CA, O=PhoneAccess'
$ca = Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue | Where-Object {
    $_.Subject -eq $caSubject -and $_.HasPrivateKey -and
    ($_.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' })
} | Select-Object -First 1
if (-not $ca) {
    # 旧版本生成的 CA 没有 basicConstraints（Android 会拒绝安装："需要提供私钥"/"无效证书"），删掉重来
    Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue | Where-Object { $_.Subject -eq $caSubject } | Remove-Item -Force -ErrorAction SilentlyContinue
    $ca = New-SelfSignedCertificate -Subject $caSubject -CertStoreLocation Cert:\CurrentUser\My `
        -KeyExportPolicy Exportable -KeyUsage CertSign, CRLSign, DigitalSignature -KeyUsageProperty Sign `
        -KeyLength 3072 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(10) -Type Custom `
        -TextExtension @('2.5.29.19={critical}{text}CA=TRUE&pathlength=1')
}

# 3) 叶子证书：SAN 覆盖当前局域网 IP + localhost（每次重新签发）
$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -match '^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' } |
    Select-Object -ExpandProperty IPAddress -Unique)
$sanParts = @()
foreach ($ip in $ips) { $sanParts += ('IPAddress=' + $ip) }
$sanParts += 'DNS=localhost'
if ($DnsName) { $sanParts += ('DNS=' + $DnsName) }
$sanExt = '2.5.29.17={text}' + ($sanParts -join '&')

$leafSubject = 'CN=PhoneAccess LAN, O=PhoneAccess'
Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue | Where-Object { $_.Subject -eq $leafSubject } | Remove-Item -Force -ErrorAction SilentlyContinue
$leaf = New-SelfSignedCertificate -Subject $leafSubject -CertStoreLocation Cert:\CurrentUser\My `
    -Signer $ca -KeyExportPolicy Exportable -KeyLength 2048 -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddYears(5) -TextExtension @($sanExt) -Type Custom

# 4) 导出 PFX + CA 证书
$tmpPfx = $leafPath + '.new'
Export-PfxCertificate -Cert $leaf -FilePath $tmpPfx -Password $sec | Out-Null
Move-Item -LiteralPath $tmpPfx -Destination $leafPath -Force
Export-Certificate -Cert $ca -FilePath $caCrtPath -Type CERT | Out-Null

# 5) 叶子从存储里删掉（PFX 已导出；CA 留在存储里以便以后重签）
Remove-Item -Path ('Cert:\CurrentUser\My\' + $leaf.Thumbprint) -Force -ErrorAction SilentlyContinue

$result = [ordered]@{
    ok = $true
    ca = $caCrtPath
    server = $leafPath
    ips = $ips
    leafThumb = $leaf.Thumbprint
    caThumb = $ca.Thumbprint
}
$result | ConvertTo-Json -Depth 4
