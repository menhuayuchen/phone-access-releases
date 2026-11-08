# calibrate.ps1 - 音画同步一次性校准：全屏黑底 + 3 次白闪，每次白闪同时响 1kHz 提示音
# 2026-11-08：客户端（手机/浏览器）一边看画面、一边听声音，测出两路到达本机的时差。
param(
  [int]$Flashes = 3,
  [int]$FlashMs = 180,
  [int]$GapMs = 800
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 2026-11-08：必须先声明 DPI 感知，否则在 150% 缩放的屏幕上 Form.Bounds 按逻辑像素算，
# 全屏白板只盖住屏幕左上角（客户端看到的是"没闪"）。声明后 Bounds 才是物理像素。
try {
  Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class PaDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }' -ErrorAction SilentlyContinue
  [void][PaDpi]::SetProcessDPIAware()
} catch { }

# ---- 生成提示音 WAV（1kHz / 130ms / 44.1k 16bit mono）----
$wav = Join-Path $env:TEMP 'pa-calib-beep.wav'
try {
  $sr = 44100
  $n = [int]($sr * 0.13)
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
  $bw.Write([int](36 + $n * 2))
  $bw.Write([System.Text.Encoding]::ASCII.GetBytes('WAVE'))
  $bw.Write([System.Text.Encoding]::ASCII.GetBytes('fmt '))
  $bw.Write([int]16)
  $bw.Write([int16]1)
  $bw.Write([int16]1)
  $bw.Write([int]$sr)
  $bw.Write([int]($sr * 2))
  $bw.Write([int16]2)
  $bw.Write([int16]16)
  $bw.Write([System.Text.Encoding]::ASCII.GetBytes('data'))
  $bw.Write([int]($n * 2))
  for ($i = 0; $i -lt $n; $i++) {
    $v = [int16]([math]::Sin(2 * [math]::PI * 1000 * $i / $sr) * 14000)
    $bw.Write($v)
  }
  $bw.Flush()
  [System.IO.File]::WriteAllBytes($wav, $ms.ToArray())
  $bw.Close()
  $ms.Close()
} catch { }

# ---- 全屏黑底窗口，按节奏闪白 ----
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Bounds = $screen
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::Black
# 2026-11-08：全屏无边框窗口会被 DWM 提升为 MPO/独立翻转平面，桌面复制（ddagrab）抓不到它
# （实测：GDI 截图是白的，清晰模式视频里完全没有白闪）。0.99 的不透明度强制走分层窗口，
# 由 DWM 合成进桌面，桌面复制才能抓到。
$form.AllowTransparency = $true
$form.Opacity = 0.99
$form.Show()
[System.Windows.Forms.Application]::DoEvents()

$player = $null
if (Test-Path -LiteralPath $wav) {
  try { $player = New-Object System.Media.SoundPlayer($wav) } catch { }
}

try {
  for ($i = 0; $i -lt $Flashes; $i++) {
    $form.BackColor = [System.Drawing.Color]::White
    $form.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
    if ($player) { try { $player.Play() } catch { } }
    Start-Sleep -Milliseconds $FlashMs
    $form.BackColor = [System.Drawing.Color]::Black
    $form.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
    if ($i -lt ($Flashes - 1)) { Start-Sleep -Milliseconds $GapMs }
  }
} finally {
  $form.Close()
  $form.Dispose()
}
