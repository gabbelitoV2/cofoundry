$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step($Message) { Write-Host "==> $Message" }

function Find-FileOnMedia($FileName) {
  foreach ($drive in Get-PSDrive -PSProvider FileSystem) {
    $candidate = Join-Path $drive.Root $FileName
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

function ConvertTo-Bytes($Size) {
  # "32G" / "32768M" / "33285996544" -> bytes. G/M/K are 1024-based (GiB/MiB/KiB),
  # matching Proxmox/qemu-img's interpretation of the same suffix on the host.
  if ($Size -match '^\s*(\d+(?:\.\d+)?)\s*([KkMmGgTt]?)[Bb]?\s*$') {
    $n = [double]$Matches[1]
    switch ($Matches[2].ToUpper()) {
      'K' { return [long]($n * 1KB) }
      'M' { return [long]($n * 1MB) }
      'G' { return [long]($n * 1GB) }
      'T' { return [long]($n * 1TB) }
      default { return [long]$n }
    }
  }
  throw "unrecognized disk size '$Size'"
}

# Shrink C: so the partition ends below the final virtual-disk size, leaving a
# margin for the GPT backup header + alignment. The host then truncates the
# qcow2 to CF_FINAL_DISK_SIZE (shrink-disk.sh); cloudbase-init's
# ExtendVolumesPlugin grows C: back to fill the disk on first boot of a clone.
function Shrink-SystemPartition($FinalSize) {
  $marginBytes = 1GB
  $finalBytes  = ConvertTo-Bytes $FinalSize
  $targetBytes = $finalBytes - $marginBytes

  $supported = Get-PartitionSupportedSize -DriveLetter C
  if ($supported.SizeMin -gt $targetBytes) {
    throw ("C: needs at least {0:N0} bytes but final disk {1} (minus 1G margin) is only {2:N0} bytes -- raise final_disk_size." -f $supported.SizeMin, $FinalSize, $targetBytes)
  }
  # Round down to a MiB boundary so the partition end is cleanly below the disk end.
  $targetBytes = [long]([math]::Floor($targetBytes / 1MB) * 1MB)

  $current = (Get-Partition -DriveLetter C).Size
  if ($current -le $targetBytes) {
    Write-Step ("C: already {0:N0} bytes (<= target {1:N0}); no shrink needed" -f $current, $targetBytes)
    return
  }
  Resize-Partition -DriveLetter C -Size $targetBytes
  $after = (Get-Partition -DriveLetter C).Size
  Write-Step ("C: shrunk {0:N0} -> {1:N0} bytes (final disk {2})" -f $current, $after, $FinalSize)
}

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

Write-Step "install Cloudbase-Init"
# Installed here -- after the last Windows Update pass, right before sysprep --
# rather than in Install.ps1. On Server 2025 the monthly checkpoint cumulative
# is applied via UpdateAgent as a full OS re-deploy (creates C:\Windows.old),
# and software installed before the WU passes does not reliably survive it.
# At this point nothing destructive runs between the install and the vzdump.
$cloudbaseMsi = Find-FileOnMedia "CloudbaseInitSetup_x64.msi"
if (-not $cloudbaseMsi) {
  $cloudbaseMsi = "C:\Windows\Temp\CloudbaseInitSetup_x64.msi"
  $msiUrl = "https://github.com/cloudbase/cloudbase-init/releases/latest/download/CloudbaseInitSetup_x64.msi"
  Write-Step "downloading Cloudbase-Init from $msiUrl"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  (New-Object System.Net.WebClient).DownloadFile($msiUrl, $cloudbaseMsi)
}
$p = Start-Process -FilePath "msiexec.exe" `
  -ArgumentList "/i", $cloudbaseMsi, "/qn", "/norestart", "RUN_SERVICE_AS_LOCAL_SYSTEM=1" `
  -Wait -PassThru
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
  throw "Cloudbase-Init MSI exited $($p.ExitCode)"
}

Write-Step "verify Cloudbase-Init"
$svc = Get-Service -Name "cloudbase-init" -ErrorAction SilentlyContinue
if (-not $svc) { throw "cloudbase-init service not found after install" }
# Keep the service enabled for clones (it applies the cloud-init password on
# first boot) but make sure it is not running during the remaining build steps.
Stop-Service -Name cloudbase-init -Force -ErrorAction SilentlyContinue
Set-Service -Name cloudbase-init -StartupType Automatic -ErrorAction SilentlyContinue

$cloudbaseConfDir = "C:\Program Files\Cloudbase Solutions\Cloudbase-Init\conf"
New-Item -ItemType Directory -Force -Path $cloudbaseConfDir | Out-Null
@"
[DEFAULT]
username=Administrator
groups=Administrators
inject_user_password=true
first_logon_behaviour=no
check_latest_version=false
bsdtar_path=C:\Program Files\Cloudbase Solutions\Cloudbase-Init\bin\bsdtar.exe
mtools_path=C:\Program Files\Cloudbase Solutions\Cloudbase-Init\bin\
verbose=true
debug=false
logdir=C:\Program Files\Cloudbase Solutions\Cloudbase-Init\log\
logfile=cloudbase-init.log
default_log_levels=comtypes=INFO,suds=INFO,iso8601=WARN,requests=WARN
local_scripts_path=C:\Program Files\Cloudbase Solutions\Cloudbase-Init\LocalScripts\
metadata_services=cloudbaseinit.metadata.services.configdrive.ConfigDriveService,cloudbaseinit.metadata.services.nocloudservice.NoCloudConfigDriveService
plugins=cloudbaseinit.plugins.common.mtu.MTUPlugin,cloudbaseinit.plugins.windows.ntpclient.NTPClientPlugin,cloudbaseinit.plugins.common.sethostname.SetHostNamePlugin,cloudbaseinit.plugins.windows.createuser.CreateUserPlugin,cloudbaseinit.plugins.common.setuserpassword.SetUserPasswordPlugin,cloudbaseinit.plugins.common.networkconfig.NetworkConfigPlugin,cloudbaseinit.plugins.windows.licensing.WindowsLicensingPlugin,cloudbaseinit.plugins.common.sshpublickeys.SetUserSSHPublicKeysPlugin,cloudbaseinit.plugins.windows.extendvolumes.ExtendVolumesPlugin,cloudbaseinit.plugins.common.userdata.UserDataPlugin,cloudbaseinit.plugins.common.localscripts.LocalScriptsPlugin

[config_drive]
types=vfat,iso
locations=cdrom,hdd,partition
"@ | Set-Content -Path (Join-Path $cloudbaseConfDir "cloudbase-init.conf") -Encoding ASCII

if ($env:CF_FINAL_DISK_SIZE) {
  Write-Step "shrink C: for final disk $($env:CF_FINAL_DISK_SIZE)"
  Shrink-SystemPartition $env:CF_FINAL_DISK_SIZE
}

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
# Must go through cmd.exe: from PowerShell the @{...} argument is parsed as a
# hashtable and winrm.cmd receives "System.Collections.Hashtable".
# Best-effort - the authoritative unpin is the policy-key removal.
cmd.exe /c 'winrm set winrm/config/service @{AllowUnencrypted="false"} >nul 2>&1'
cmd.exe /c 'winrm set winrm/config/service/auth @{Basic="false"} >nul 2>&1'

Write-Step "restore Windows Update automatic-reboot behavior"
# Install.ps1 disabled WU auto-update/auto-reboot for the build so the Server 2025
# checkpoint cumulative could not restart the VM mid-provisioner. Undo it so the
# sysprep'd template ships with Windows' default update policy instead of an
# inherited "never auto-reboot" state that would silently change behavior on
# every clone.
Remove-Item -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU" -Force -Recurse -ErrorAction SilentlyContinue
foreach ($t in @("Reboot", "Reboot_AC", "Reboot_Battery")) {
  Enable-ScheduledTask -TaskPath "\Microsoft\Windows\UpdateOrchestrator\" -TaskName $t -ErrorAction SilentlyContinue | Out-Null
}

Write-Step "sysprep and shutdown"
# Pass cloudbase-init's bundled Unattend.xml so OOBE on the cloned VM auto-
# completes (accepts EULA, sets a placeholder Administrator password, skips
# all OOBE screens). Without this, first boot blocks in noVNC waiting for an
# operator to set the Administrator password, and the cloudbase-init service
# can't start until OOBE finishes -- which defeats unattended cloning.
$sysprepUnattend = "C:\Program Files\Cloudbase Solutions\Cloudbase-Init\conf\Unattend.xml"
if (-not (Test-Path $sysprepUnattend)) {
  throw "cloudbase-init Unattend.xml not found at $sysprepUnattend - was Cloudbase-Init installed?"
}
# Copy to a space-free path: with the "Program Files" path, Start-Process's
# argument joining mangles the quoting and sysprep aborts with "Unable to
# parse command-line arguments" -- while still exiting 0, so the build
# "succeeds" with a non-generalized image. (Sysprep caches the answer file
# into C:\Windows\Panther at generalize, so the temp source path is fine.)
$unattendCopy = "C:\Windows\Temp\cb-sysprep-unattend.xml"
Copy-Item $sysprepUnattend $unattendCopy -Force
$p = Start-Process -FilePath "C:\Windows\System32\Sysprep\Sysprep.exe" `
  -ArgumentList "/generalize", "/oobe", "/shutdown", "/quiet", "/unattend:$unattendCopy" `
  -Wait -PassThru
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
  throw "Sysprep exited $($p.ExitCode)"
}
# Sysprep writes this tag only when generalize actually succeeded -- its exit
# code alone is unreliable (a command-line parse failure also exits 0).
$deadline = [DateTime]::Now.AddMinutes(2)
$tagPath = "C:\Windows\System32\Sysprep\Sysprep_succeeded.tag"
while (-not (Test-Path $tagPath) -and [DateTime]::Now -lt $deadline) { Start-Sleep 5 }
if (-not (Test-Path $tagPath)) {
  throw "Sysprep did not generalize (Sysprep_succeeded.tag missing) - check C:\Windows\System32\Sysprep\Panther\setupact.log"
}

# All failure paths above throw; reaching here is success. Explicit exit 0 so a
# stale $LastExitCode from an earlier native command can't fail the provisioner
# (the machine is about to power off from sysprep /shutdown).
exit 0
