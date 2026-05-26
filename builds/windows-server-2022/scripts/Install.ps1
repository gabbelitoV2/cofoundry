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

Write-Step "disable CompactOS"
Compact.exe /CompactOS:never | Out-Null

Write-Step "install VirtIO guest tools"
$virtioInstaller = Find-FileOnMedia "virtio-win-guest-tools.exe"
if (-not $virtioInstaller) {
  throw "virtio-win-guest-tools.exe not found on attached media"
}
$p = Start-Process -FilePath $virtioInstaller -ArgumentList "/quiet", "/norestart" -Wait -PassThru
if ($p.ExitCode -ne 0) {
  throw "VirtIO installer exited $($p.ExitCode)"
}

Write-Step "verify QEMU Guest Agent"
$deadline = [DateTime]::Now.AddSeconds(60)
while ([DateTime]::Now -lt $deadline) {
  $svc = Get-Service -Name "QEMU-GA" -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -eq "Running") { break }
  Start-Sleep 5
}
$svc = Get-Service -Name "QEMU-GA" -ErrorAction SilentlyContinue
if (-not $svc) { throw "QEMU-GA service not found after VirtIO install" }
if ($svc.Status -ne "Running") { throw "QEMU-GA service is not running (status: $($svc.Status))" }
if (-not (Test-Path "\\.\Global\org.qemu.guest_agent.0")) {
  throw "virtio-serial channel not present - VirtIO serial driver may not be loaded"
}
Write-Step "QEMU Guest Agent: running, channel open"

Write-Step "install Cloudbase-Init"
$cloudbaseMsi = Find-FileOnMedia "CloudbaseInitSetup_x64.msi"
if (-not $cloudbaseMsi) {
  $cloudbaseMsi = "$env:TEMP\CloudbaseInitSetup_x64.msi"
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

$cloudbaseConfDir = "C:\Program Files\Cloudbase Solutions\Cloudbase-Init\conf"
New-Item -ItemType Directory -Force -Path $cloudbaseConfDir | Out-Null
@"
[DEFAULT]
username=Administrator
groups=Administrators
inject_user_password=true
first_logon_behaviour=no
config_drive_raw_hhd=true
config_drive_cdrom=true
bsdtar_path=C:\Program Files\Cloudbase Solutions\Cloudbase-Init\bin\bsdtar.exe
mtools_path=C:\Program Files\Cloudbase Solutions\Cloudbase-Init\bin\
verbose=true
debug=false
logdir=C:\Program Files\Cloudbase Solutions\Cloudbase-Init\log\
logfile=cloudbase-init.log
metadata_services=cloudbaseinit.metadata.services.configdrive.ConfigDriveService,cloudbaseinit.metadata.services.nocloudservice.NoCloudConfigDriveService
plugins=cloudbaseinit.plugins.common.mtu.MTUPlugin,cloudbaseinit.plugins.windows.ntpclient.NTPClientPlugin,cloudbaseinit.plugins.common.sethostname.SetHostNamePlugin,cloudbaseinit.plugins.windows.createuser.CreateUserPlugin,cloudbaseinit.plugins.common.networkconfig.NetworkConfigPlugin,cloudbaseinit.plugins.windows.licensing.WindowsLicensingPlugin,cloudbaseinit.plugins.common.sshpublickeys.SetUserSSHPublicKeysPlugin,cloudbaseinit.plugins.windows.extendvolumes.ExtendVolumesPlugin,cloudbaseinit.plugins.common.userdata.UserDataPlugin,cloudbaseinit.plugins.common.localscripts.LocalScriptsPlugin
"@ | Set-Content -Path (Join-Path $cloudbaseConfDir "cloudbase-init.conf") -Encoding ASCII

Write-Step "enable services"
Set-Service -Name cloudbase-init -StartupType Automatic -ErrorAction SilentlyContinue
Set-Service -Name QEMU-GA -StartupType Automatic -ErrorAction SilentlyContinue

Write-Step "register WinRM keepalive startup task"
# Defender platform updates (KB4052623 / platform 4.18.26040+) reset WinRM
# AllowUnencrypted and Basic auth on reboot. Re-apply on every boot so Packer
# can reconnect after each windows-restart provisioner cycle.
$winrmFixPath = "C:\Windows\System32\packer-winrm-keepalive.ps1"
@'
winrm set winrm/config/service @{AllowUnencrypted="true"} 2>&1 | Out-Null
winrm set winrm/config/service/auth @{Basic="true"} 2>&1 | Out-Null
'@ | Set-Content $winrmFixPath -Encoding UTF8
$action    = New-ScheduledTaskAction -Execute "powershell.exe" `
               -Argument "-ExecutionPolicy Bypass -NonInteractive -File `"$winrmFixPath`""
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName "PackerWinRMKeepalive" -Action $action `
  -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Write-Step "clean up UEFI boot order"
# OVMF re-adds the SATA DVD-ROM (VirtIO ISO) to the front of BootOrder on every
# boot, causing a ~60s hang per restart (DVD timeout + PXE timeout) before
# reaching Windows. Delete the DVD-ROM and PXE entries entirely so subsequent
# reboots go straight to the Windows Boot Manager.
$raw = & bcdedit.exe /enum firmware 2>&1 | Out-String
$blocks = ($raw -split '(?m)^-{2,}') | Where-Object { $_ -match 'identifier' }
foreach ($block in $blocks) {
  $id   = if ($block -match 'identifier\s+(\S+)') { $Matches[1] } else { continue }
  $desc = if ($block -match 'description\s+(.+)')  { $Matches[1].Trim() } else { '' }
  if ($id -eq '{fwbootmgr}') { continue }
  if ($desc -match 'DVD|ROM|Network|IPv[46]|PXE|EFI Shell') {
    bcdedit.exe /delete $id 2>&1 | Out-Null
    Write-Host "    removed UEFI boot entry: $desc ($id)"
  }
}
bcdedit.exe /set '{fwbootmgr}' displayorder '{bootmgr}' /addfirst 2>&1 | Out-Null
