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

Write-Step "stop Windows Update service and purge download cache"
Stop-Service -Name wuauserv -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path "C:\Windows\SoftwareDistribution\Download" -Force -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Write-Step "purge log and cache directories"
$prunePaths = @(
  "C:\Windows\Logs\CBS",
  "C:\Windows\Panther",
  "C:\ProgramData\Microsoft\Windows\WER",
  "C:\Windows\Prefetch",
  "C:\Windows\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache"
)
foreach ($p in $prunePaths) {
  if (Test-Path $p) {
    Get-ChildItem -Path $p -Force -ErrorAction SilentlyContinue |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Step "empty recycle bin"
Clear-RecycleBin -Force -ErrorAction SilentlyContinue

Write-Step "cleanup component store"
Start-Process -FilePath "dism.exe" `
  -ArgumentList "/Online", "/Cleanup-Image", "/StartComponentCleanup", "/ResetBase" -Wait

Write-Step "clear temp directories and event logs"
Get-ChildItem -Path "C:\Windows\Temp", "$env:TEMP" -Force -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
$ErrorActionPreference = "SilentlyContinue"
wevtutil el | ForEach-Object { wevtutil cl $_ 2>&1 | Out-Null }
$ErrorActionPreference = "Stop"

Write-Step "zero free space"
Zero-FreeSpace "C"
Optimize-Volume -DriveLetter C -ReTrim -ErrorAction SilentlyContinue

Write-Step "re-enable system-managed pagefile"
# PreFinalize.ps1 + the windows-restart before this script freed pagefile.sys
# so the zero pass above could compress that space. Restore the default
# "automatically manage" setting so the cloned VM recreates pagefile.sys at
# the correct size on first boot.
$cs = Get-CimInstance -ClassName Win32_ComputerSystem
Set-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = $true }

Write-Step "remove Packer WinRM keepalive task and policy pins"
Unregister-ScheduledTask -TaskName "PackerWinRMKeepalive" -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item "C:\Windows\System32\packer-winrm-keepalive.ps1" -Force -ErrorAction SilentlyContinue
# Remove the Group Policy registry keys that pinned Basic auth / AllowUnencrypted
# during the build so the sysprep'd template ships with WinRM in its secure default state.
Remove-Item -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WinRM\Service" -Force -ErrorAction SilentlyContinue
winrm set winrm/config/service @{AllowUnencrypted="false"} 2>&1 | Out-Null
winrm set winrm/config/service/auth @{Basic="false"} 2>&1 | Out-Null

Write-Step "sysprep and shutdown"
$p = Start-Process -FilePath "C:\Windows\System32\Sysprep\Sysprep.exe" `
  -ArgumentList "/generalize", "/oobe", "/shutdown", "/quiet" -Wait -PassThru
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
  throw "Sysprep exited $($p.ExitCode)"
}
