# 把关系复原胶和它的公网隧道都拉起来：已经在跑就不重复开，地址写到文件里。
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$node = 'C:\Users\Administrator\OpenFilm\runtime\node\node.exe'
$cf = Join-Path $PSScriptRoot 'cloudflared.exe'
$log = Join-Path $PSScriptRoot 'tunnel.log'
$urlFile = Join-Path $root '公网地址.txt'

function Test-Server {
  try { $r = Invoke-WebRequest 'http://127.0.0.1:5178/api/health' -UseBasicParsing -TimeoutSec 2; return $r.StatusCode -eq 200 } catch { return $false }
}

if (-not (Test-Server)) {
  Start-Process -FilePath $node -ArgumentList @((Join-Path $root 'server.mjs')) -WorkingDirectory $root -WindowStyle Hidden
  for ($i = 0; $i -lt 30 -and -not (Test-Server); $i++) { Start-Sleep -Milliseconds 400 }
}

$running = Get-Process cloudflared -ErrorAction SilentlyContinue
if (-not $running) {
  if (Test-Path $log) { Remove-Item $log -Force }
  # 用 cmd 起，输出写进文件；这样 PowerShell 退出后隧道也不会被带走
  Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', "`"$cf`" tunnel --url http://127.0.0.1:5178 --no-autoupdate > `"$log`" 2>&1") -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
  for ($i = 0; $i -lt 60 -and -not ($running = Get-Process cloudflared -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 400 }
}

$url = $null
for ($i = 0; $i -lt 40 -and -not $url; $i++) {
  if (Test-Path $log) {
    $m = [regex]::Match((Get-Content $log -Raw), 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($m.Success) { $url = $m.Value }
  }
  if (-not $url) { Start-Sleep -Milliseconds 500 }
}
if ($url) {
  $line = "关系复原胶 公网地址：$url`r`n本机地址：http://127.0.0.1:5178/`r`n（电脑开着就一直有效）"
  [IO.File]::WriteAllText($urlFile, $line, (New-Object System.Text.UTF8Encoding($false)))
  Set-Clipboard -Value $url
  Write-Output $url
} else {
  Write-Output '隧道还没起来，稍等几秒再运行一次。'
}
