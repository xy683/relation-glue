# Local payment watcher: reads the WeChat window with Windows OCR, looks for a
# 29.9 yuan incoming payment, and tells the server to release the order.
# Requires: Windows 10/11, WeChat desktop logged in, this PC staying on.
param(
  [string]$Server = 'http://124.223.2.216:5178',
  [Parameter(Mandatory = $true)][string]$Token,
  [int]$IntervalSec = 3
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $here 'pay-watch.log'
$img = Join-Path $env:TEMP 'pay-watch.png'
$ocrOut = Join-Path $env:TEMP 'pay-watch.json'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PW {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder t, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[PW]::SetProcessDPIAware() | Out-Null

function Write-Log([string]$text) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $text
  try { Add-Content -Path $log -Value $line -Encoding UTF8 } catch { }
}

function Get-ChatWindow {
  $best = $null
  $cb = [PW+EnumWindowsProc] {
    param($h, $l)
    $len = [PW]::GetWindowTextLength($h)
    if ($len -le 0) { return $true }
    $sb = New-Object System.Text.StringBuilder ($len + 2)
    [PW]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
    $title = $sb.ToString()
    $procId = 0
    [PW]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { return $true }
    $name = $p.ProcessName.ToLower()
    if (-not ($name -like 'weixin*' -or $name -like 'wechat*' -or $name -like 'alipay*')) { return $true }
    if ($title -notmatch '微信|WeChat|Weixin|支付宝|Alipay') { return $true }
    $r = New-Object PW+RECT
    [PW]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left
    $hh = $r.Bottom - $r.Top
    if ($w -lt 200 -or $hh -lt 200) { return $true }
    if (-not $script:best -or ($w * $hh) -gt ($script:best.w * $script:best.h)) {
      $script:best = [pscustomobject]@{ h = $h; w = $w; hh = $hh; title = $title }
    }
    return $true
  }
  $script:best = $null
  [PW]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $script:best
}

function Capture-Window($win) {
  # show without activation, park it off-screen so the user is not disturbed
  [PW]::ShowWindow($win.h, 4) | Out-Null
  [PW]::SetWindowPos($win.h, [IntPtr]::Zero, 3000, 0, $win.w, $win.hh, 0x0014) | Out-Null
  Start-Sleep -Milliseconds 120
  $bmp = New-Object System.Drawing.Bitmap $win.w, $win.hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [PW]::PrintWindow($win.h, $hdc, 2) | Out-Null
  $g.ReleaseHdc($hdc); $g.Dispose()
  $bmp.Save($img, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

function Test-Blank([string]$path) {
  try {
    $bmp = [System.Drawing.Bitmap]::FromFile($path)
    $colors = @{}
    for ($x = 0; $x -lt $bmp.Width; $x += [Math]::Max(1, [int]($bmp.Width / 16))) {
      for ($y = 0; $y -lt $bmp.Height; $y += [Math]::Max(1, [int]($bmp.Height / 16))) {
        $p = $bmp.GetPixel($x, $y)
        $colors["$($p.R),$($p.G),$($p.B)"] = 1
      }
    }
    $bmp.Dispose()
    return $colors.Keys.Count -lt 3
  } catch { return $true }
}

function Find-Amount([string]$text) {
  # "微信支付收款 29.90 元" / "收款到账 29.9" / anything with 收款 + 29.9x
  $m = [regex]::Match($text, '(?:收款|到账|收到)[^\d]{0,10}(29\s*[.．,，]\s*9\d?)')
  if ($m.Success) { return 29.9 }
  return 0
}

$seen = @{}
Write-Log "watch started server=$Server interval=$IntervalSec"
while ($true) {
  try {
    $win = Get-ChatWindow
    if (-not $win) { Write-Log 'no wechat/alipay window'; Start-Sleep -Seconds $IntervalSec; continue }
    Capture-Window $win
    if (Test-Blank $img) { Write-Log 'blank capture (window hidden/gpu)'; Start-Sleep -Seconds $IntervalSec; continue }
    $null = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'ocr.ps1') $img $ocrOut 2>$null
    if (-not (Test-Path $ocrOut)) { Write-Log 'no ocr output'; Start-Sleep -Seconds $IntervalSec; continue }
    $ocr = Get-Content $ocrOut -Raw -Encoding UTF8 | ConvertFrom-Json
    $lines = @($ocr.lines)
    foreach ($line in $lines) {
      $t = [string]$line.text
      $amount = Find-Amount $t
      if ($amount -le 0) { continue }
      $key = ('{0}|{1}|{2}' -f $amount, [int]$line.y, $t)
      $now = Get-Date
      if ($seen.ContainsKey($key) -and ($now - $seen[$key]).TotalMinutes -lt 10) { continue }
      $seen[$key] = $now
      Write-Log "detected: $t"
      try {
        $body = @{ amount = $amount; text = $t } | ConvertTo-Json -Compress
        $res = Invoke-RestMethod -Uri ($Server.TrimEnd('/') + '/api/pay/local?token=' + [uri]::EscapeDataString($Token)) -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 8
        Write-Log ("released order " + $res.orderId)
      } catch { Write-Log ("post failed: " + $_.Exception.Message) }
    }
  } catch { Write-Log ("error: " + $_.Exception.Message) }
  Start-Sleep -Seconds $IntervalSec
}
