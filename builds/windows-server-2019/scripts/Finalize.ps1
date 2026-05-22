$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step($Message) { Write-Host "==> $Message" }

function Zero-FreeSpace($DriveLetter) {
  $root   = "${DriveLetter}:\"
  $target = Join-Path $root "zero.fill"
  $buffer = New-Object byte[] (1024 * 1024)
  $stream = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew)
  try {
    while ($true) { $stream.Write($buffer, 0, $buffer.Length) }
  } catch [System.IO.IOException] {
  } finally {
    $stream.Close()
    Remove-Item -Force $target -ErrorAction SilentlyContinue
  }
}

Write-Step "cleanup component store and logs"
Start-Process -FilePath "dism.exe" `
  -ArgumentList "/Online", "/Cleanup-Image", "/StartComponentCleanup", "/ResetBase" -Wait
Get-ChildItem -Path "C:\Windows\Temp", "$env:TEMP" -Force -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
$ErrorActionPreference = "SilentlyContinue"
wevtutil el | ForEach-Object { wevtutil cl $_ 2>&1 | Out-Null }
$ErrorActionPreference = "Stop"

Write-Step "zero free space"
Zero-FreeSpace "C"
Optimize-Volume -DriveLetter C -ReTrim -ErrorAction SilentlyContinue

Write-Step "sysprep and shutdown"
$p = Start-Process -FilePath "C:\Windows\System32\Sysprep\Sysprep.exe" `
  -ArgumentList "/generalize", "/oobe", "/shutdown", "/quiet" -Wait -PassThru
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
  throw "Sysprep exited $($p.ExitCode)"
}
