Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DBG {
  public delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@ | Out-Null
$rows = New-Object System.Collections.ArrayList
$cb = [DBG+Cb] {
  param($h, $l)
  $pid2 = 0
  [DBG]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  $p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
  if (-not $p) { return $true }
  $n = [DBG]::GetWindowTextLength($h)
  $title = ''
  if ($n -gt 0) { $sb = New-Object System.Text.StringBuilder ($n + 2); [DBG]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null; $title = $sb.ToString() }
  $r = New-Object DBG+RECT
  [DBG]::GetWindowRect($h, [ref]$r) | Out-Null
  [void]$rows.Add([pscustomobject]@{ pid = $pid2; name = $p.ProcessName; visible = [DBG]::IsWindowVisible($h); title = $title; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top) })
  return $true
}
[DBG]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$rows | Where-Object { $_.title -match '微信|Weixin|QQ|快手|抖音' -or $_.name -match 'Weixin|WeChat|QQ|Kuaishou|Douyin' } | Format-Table -AutoSize | Out-String -Width 160
[Console]::OutputEncoding = [Text.Encoding]::UTF8
"total windows: " + $rows.Count
