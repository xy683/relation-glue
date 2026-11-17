# 找到（或打开）微信 / QQ / 抖音 / 快手，把它带到最前面。
# 不靠 Process.MainWindowHandle（多窗口时它常是 0），而是枚举所有顶层窗口按进程名找，稳定得多。
# 用法：powershell.exe -NoProfile -ExecutionPolicy Bypass -File app-window.ps1 -Action status|open|focus|capture -Hint wechat|qq|douyin|kuaishou [-Out 图片路径]
param(
  [Parameter(Mandatory = $true)][ValidateSet('status', 'list', 'open', 'focus', 'capture')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Hint,
  [string]$Out
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing | Out-Null

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class GlueWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@ | Out-Null
[GlueWin]::SetProcessDPIAware() | Out-Null

$apps = @{
  wechat   = @{ titles = @('微信', 'WeChat', 'Weixin'); procs = @('weixin', 'wechat', 'wechatapp'); shortcuts = @('微信', 'WeChat', 'Weixin') }
  qq       = @{ titles = @('QQ'); procs = @('qq', 'qqnt', 'qqsclauncher', 'qqprotect'); shortcuts = @('QQ', '腾讯QQ') }
  douyin   = @{ titles = @('抖音', 'Douyin'); procs = @('douyin', 'douyinlive', '抖音'); shortcuts = @('抖音', 'Douyin') }
  kuaishou = @{ titles = @('快手', 'Kuaishou'); procs = @('kuaishou', 'kwailive', '快手'); shortcuts = @('快手', 'Kuaishou') }
}
$spec = $apps[$Hint]
if (-not $spec) { '{"ok":false,"error":"unknown app"}'; exit 2 }

function Get-TopWindows {
  $found = New-Object System.Collections.ArrayList
  $callback = [GlueWin+EnumWindowsProc] {
    param($hWnd, $lParam)
    $visible = [GlueWin]::IsWindowVisible($hWnd)
    $len = [GlueWin]::GetWindowTextLength($hWnd)
    if ($len -le 0) { return $true }
    $sb = New-Object System.Text.StringBuilder ($len + 2)
    [GlueWin]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
    $title = $sb.ToString()
    if (-not $title) { return $true }
    $procId = 0
    [GlueWin]::GetWindowThreadProcessId($hWnd, [ref]$procId) | Out-Null
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $proc) { return $true }
    $name = $proc.ProcessName.ToLower()
    $byProc = $spec.procs -contains $name
    $byTitle = $false
    foreach ($t in $spec.titles) { if ($title -like "*$t*") { $byTitle = $true } }
    if (-not ($byProc -or $byTitle)) { return $true }
    if ($title -match 'GitHub|Google|Chrome|Edge|http|localhost|openfilm|浏览器|卸载|Uninstall|IME|TrayIcon|MSCTF|GDI\+|Dummy|TXMenu|Default') { return $true }
    $r = New-Object GlueWin+RECT
    [GlueWin]::GetWindowRect($hWnd, [ref]$r) | Out-Null
    $w = [Math]::Max(0, $r.Right - $r.Left)
    $h = [Math]::Max(0, $r.Bottom - $r.Top)
    if ($w -lt 60 -or $h -lt 60) { return $true }
    [void]$found.Add([pscustomobject]@{ handle = $hWnd; title = $title; pid = $procId; name = $proc.ProcessName; width = $w; height = $h; area = $w * $h; byTitle = $byTitle; visible = $visible })
    return $true
  }
  [GlueWin]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
  return @($found)
}

function Get-BestWindow {
  $windows = Get-TopWindows
  if (-not $windows.Count) { return $null }
  return ($windows | Sort-Object -Property @{ Expression = 'visible'; Descending = $true }, @{ Expression = 'byTitle'; Descending = $true }, @{ Expression = 'area'; Descending = $true } | Select-Object -First 1)
}

function Force-Foreground($handle) {
  if ([GlueWin]::IsIconic($handle)) { [GlueWin]::ShowWindow($handle, 9) | Out-Null }
  [GlueWin]::ShowWindow($handle, 5) | Out-Null
  try {
    $fg = [GlueWin]::GetForegroundWindow()
    $fgPid = 0
    $fgThread = [GlueWin]::GetWindowThreadProcessId($fg, [ref]$fgPid)
    $me = [GlueWin]::GetCurrentThreadId()
    [GlueWin]::AttachThreadInput($me, $fgThread, $true) | Out-Null
    [GlueWin]::SetForegroundWindow($handle) | Out-Null
    [GlueWin]::BringWindowToTop($handle) | Out-Null
    [GlueWin]::AttachThreadInput($me, $fgThread, $false) | Out-Null
  } catch {
    [GlueWin]::SetForegroundWindow($handle) | Out-Null
  }
  Start-Sleep -Milliseconds 250
}

function Get-Shortcut {
  $roots = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    'C:\ProgramData\Microsoft\Windows\Start Menu\Programs',
    [Environment]::GetFolderPath('Desktop')
  )
  $shell = New-Object -ComObject WScript.Shell
  $found = @()
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($link in Get-ChildItem $root -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue) {
      if ($link.BaseName -match '卸载|安装|修复|更新|uninstall|setup') { continue }
      foreach ($name in $spec.shortcuts) {
        if ($link.BaseName -eq $name) { $found += @{ link = $link; exact = $true } }
        elseif ($link.BaseName -like "*$name*") { $found += @{ link = $link; exact = $false } }
      }
    }
  }
  if (-not $found.Count) { return $null }
  $best = ($found | Sort-Object -Property @{ Expression = 'exact'; Descending = $true } | Select-Object -First 1).link
  return $best.FullName
}

function Wait-Window($seconds) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) {
    $win = Get-BestWindow
    if ($win) { return $win }
    Start-Sleep -Milliseconds 500
  }
  return $null
}

function Send-Result($payload) {
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  Write-Output (ConvertTo-Json $payload -Compress)
}

if ($Action -eq 'status' -or $Action -eq 'list') {
  $windows = Get-TopWindows
  $best = if ($windows.Count) { ($windows | Sort-Object -Property @{ Expression = 'area'; Descending = $true } | Select-Object -First 1) } else { $null }
  Send-Result ([ordered]@{ ok = $true; running = [bool]$windows.Count; windows = $windows.Count; title = $best.title; installed = [bool](Get-Shortcut) })
  exit 0
}

$window = Get-BestWindow
if ($Action -eq 'open') {
  if ($window) {
    Force-Foreground $window.handle
    Send-Result ([ordered]@{ ok = $true; already = $true; title = $window.title; windows = (Get-TopWindows).Count })
    exit 0
  }
  $shortcut = Get-Shortcut
  if (-not $shortcut) {
    Send-Result ([ordered]@{ ok = $false; error = '这台电脑上没找到它的启动方式，先手动打开一次。' })
    exit 3
  }
  try {
    # 用快捷方式本身启动：目标、参数、工作目录都由系统还原，最不容易出错
    Start-Process -FilePath $shortcut | Out-Null
  } catch {
    Send-Result ([ordered]@{ ok = $false; error = "启动失败：$($_.Exception.Message)" })
    exit 6
  }
  # 客户端登录、更新都要时间：最多等 45 秒，一出现就返回
  $window = Wait-Window 45
  if ($window) {
    Force-Foreground $window.handle
    Send-Result ([ordered]@{ ok = $true; already = $false; title = $window.title; windows = (Get-TopWindows).Count })
  } else {
    Send-Result ([ordered]@{ ok = $false; launched = $true; error = '已经启动，但还没出现窗口（可能在登录或更新）。弄好后回到这里再点一次，或点「重试」。' })
  }
  exit 0
}

if (-not $window) {
  Send-Result ([ordered]@{ ok = $false; error = '它现在没有窗口。先点「打开」，在它里面选好聊天，再回来。' })
  exit 4
}

if ($Action -eq 'focus') {
  Force-Foreground $window.handle
  Send-Result ([ordered]@{ ok = $true; title = $window.title })
  exit 0
}

# capture：先让窗口自己画一张，不行再按屏幕位置截
Force-Foreground $window.handle
$rect = New-Object GlueWin+RECT
[GlueWin]::GetWindowRect($window.handle, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -lt 80 -or $height -lt 80) { Send-Result ([ordered]@{ ok = $false; error = '窗口太小。' }); exit 5 }

function Save-Bitmap($bitmap, $path) { $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bitmap.Dispose() }
function Test-Blank($path) {
  $bmp = [System.Drawing.Bitmap]::FromFile($path)
  try {
    $colors = @{}
    for ($x = 0; $x -lt $bmp.Width; $x += [Math]::Max(1, [int]($bmp.Width / 24))) {
      for ($y = 0; $y -lt $bmp.Height; $y += [Math]::Max(1, [int]($bmp.Height / 24))) {
        $p = $bmp.GetPixel($x, $y); $colors["$($p.R),$($p.G),$($p.B)"] = 1
      }
    }
    return $colors.Keys.Count -lt 3
  } finally { $bmp.Dispose() }
}

$drawn = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($drawn)
$hdc = $graphics.GetHdc()
[GlueWin]::PrintWindow($window.handle, $hdc, 2) | Out-Null
$graphics.ReleaseHdc($hdc)
$graphics.Dispose()
Save-Bitmap $drawn $Out
if (Test-Blank $Out) {
  $screen = New-Object System.Drawing.Bitmap $width, $height
  $g = [System.Drawing.Graphics]::FromImage($screen)
  $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size $width, $height))
  $g.Dispose()
  Save-Bitmap $screen $Out
}
Send-Result ([ordered]@{ ok = $true; title = $window.title; width = $width; height = $height; path = $Out })
