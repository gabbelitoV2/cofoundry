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
