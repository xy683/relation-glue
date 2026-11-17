# 用 Windows 自带的中文 OCR 读一张聊天截图，每一行连同它的位置写成 JSON。
# 用法：powershell.exe -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 <图片路径> <输出 JSON 路径>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
function Await($operation, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  $task.Result
}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { [IO.File]::WriteAllText($Out, '{"error":"unavailable"}', [Text.Encoding]::UTF8); exit 3 }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = foreach ($line in $result.Lines) {
  $xs = @(); $ys = @(); $rights = @(); $hs = @()
  foreach ($word in $line.Words) {
    $r = $word.BoundingRect
    if ($r.Width -le 0) { continue }
    $xs += $r.X; $ys += $r.Y; $rights += ($r.X + $r.Width); $hs += $r.Height
  }
  if (-not $xs.Count) { continue }
  $words = foreach ($word in $line.Words) { $word.Text }
  [ordered]@{
    x = [math]::Round(($xs | Measure-Object -Minimum).Minimum, 1)
    y = [math]::Round(($ys | Measure-Object -Minimum).Minimum, 1)
    w = [math]::Round((($rights | Measure-Object -Maximum).Maximum - ($xs | Measure-Object -Minimum).Minimum), 1)
    h = [math]::Round(($hs | Measure-Object -Maximum).Maximum, 1)
    text = ($words -join ' ')
  }
}
$payload = [ordered]@{
  width = [math]::Round($bitmap.PixelWidth, 0); height = [math]::Round($bitmap.PixelHeight, 0)
  language = $engine.RecognizerLanguage.LanguageTag
  lines = @($lines)
}
[IO.File]::WriteAllText($Out, (ConvertTo-Json $payload -Depth 6 -Compress), (New-Object System.Text.UTF8Encoding($false)))
