$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step($Message) {
  Write-Host "==> $Message"
}

function Find-FileOnMedia($FileName) {
  foreach ($drive in Get-PSDrive -PSProvider FileSystem) {
    $candidate = Join-Path $drive.Root $FileName
    if (Test-Path $candidate) {
      return $candidate
    }
  }
  return $null
}

function Zero-FreeSpace($DriveLetter) {
  $root = "${DriveLetter}:\"
  $target = Join-Path $root "zero.fill"
  $buffer = New-Object byte[] (1024 * 1024)
  $stream = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew)
  try {
    while ($true) {
      $stream.Write($buffer, 0, $buffer.Length)
    }
  } catch [System.IO.IOException] {
  } finally {
    $stream.Close()
    Remove-Item -Force $target -ErrorAction SilentlyContinue
  }
}

Write-Step "install VirtIO guest tools"
$virtioInstaller = Find-FileOnMedia "virtio-win-guest-tools.exe"
if (-not $virtioInstaller) {
  throw "virtio-win-guest-tools.exe not found on attached media"
}
Start-Process -FilePath $virtioInstaller -ArgumentList "/quiet", "/norestart" -Wait

Write-Step "install Cloudbase-Init"
$cloudbaseMsi = Find-FileOnMedia "CloudbaseInitSetup_x64.msi"
if (-not $cloudbaseMsi) {
  # Not on media — download from GitHub releases
  $cloudbaseMsi = "$env:TEMP\CloudbaseInitSetup_Stable_x64.msi"
  $msiUrl = "https://github.com/cloudbase/cloudbase-init/releases/latest/download/CloudbaseInitSetup_Stable_x64.msi"
  Write-Step "downloading Cloudbase-Init MSI from $msiUrl"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  (New-Object System.Net.WebClient).DownloadFile($msiUrl, $cloudbaseMsi)
}
Start-Process -FilePath "msiexec.exe" -ArgumentList "/i", $cloudbaseMsi, "/qn", "/norestart", "RUN_SERVICE_AS_LOCAL_SYSTEM=1" -Wait

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

Write-Step "install Windows Updates"
$WUFlag = "C:\Windows\Temp\tb-wu-done.flag"
$WURebootFlag = "C:\Windows\Temp\tb-wu-reboot.flag"
$WUScript = "C:\Windows\Temp\tb-wu.ps1"
$WUTaskName = "TBWindowsUpdate"

if (-not (Test-Path $WUFlag)) {
  # WinRM runs with a restricted network token that cannot access the Windows
  # Update COM API. Run a SYSTEM scheduled task with RunLevel Highest instead.
  @'
$ErrorActionPreference = "SilentlyContinue"
Remove-Item "C:\Windows\Temp\tb-wu-reboot.flag" -Force -ErrorAction SilentlyContinue
$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$found = $searcher.Search("IsInstalled=0 and Type='Software' and IsHidden=0")
if ($found.Updates.Count -eq 0) {
  Set-Content "C:\Windows\Temp\tb-wu-done.flag" "done"
  exit
}
$dl = $session.CreateUpdateDownloader()
$dl.Updates = $found.Updates
$dl.Download()
$inst = $session.CreateUpdateInstaller()
$inst.Updates = $found.Updates
$result = $inst.Install()
if ($result.RebootRequired) {
  Set-Content "C:\Windows\Temp\tb-wu-reboot.flag" "reboot"
} else {
  Set-Content "C:\Windows\Temp\tb-wu-done.flag" "done"
}
'@ | Set-Content $WUScript -Encoding UTF8

  $action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-ExecutionPolicy Bypass -NonInteractive -File `"$WUScript`""
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 3)
  Register-ScheduledTask -TaskName $WUTaskName -Action $action `
    -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $WUTaskName

  Write-Step "waiting for Windows Update to complete (SYSTEM task)..."
  $deadline = [DateTime]::Now.AddHours(2)
  while (-not (Test-Path $WUFlag) -and -not (Test-Path $WURebootFlag) -and [DateTime]::Now -lt $deadline) {
    Start-Sleep 30
  }

  Unregister-ScheduledTask -TaskName $WUTaskName -Confirm:$false -ErrorAction SilentlyContinue

  if (Test-Path $WURebootFlag) {
    Write-Step "updates installed, reboot required - rebooting"
    Restart-Computer -Force
    Start-Sleep 60
    exit
  }

  if (-not (Test-Path $WUFlag)) {
    Write-Step "Windows Update timed out after 2h — continuing anyway"
  }
}

Write-Step "cleanup component store and logs"
Start-Process -FilePath "dism.exe" -ArgumentList "/Online", "/Cleanup-Image", "/StartComponentCleanup", "/ResetBase" -Wait
Get-ChildItem -Path "C:\Windows\Temp", "$env:TEMP" -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
$ErrorActionPreference = "SilentlyContinue"
wevtutil el | ForEach-Object { wevtutil cl $_ 2>&1 | Out-Null }
$ErrorActionPreference = "Stop"

Write-Step "zero free space"
Zero-FreeSpace "C"
Optimize-Volume -DriveLetter C -ReTrim -ErrorAction SilentlyContinue

Write-Step "sysprep and shutdown"
Start-Process -FilePath "C:\Windows\System32\Sysprep\Sysprep.exe" -ArgumentList "/generalize", "/oobe", "/shutdown", "/quiet" -Wait
