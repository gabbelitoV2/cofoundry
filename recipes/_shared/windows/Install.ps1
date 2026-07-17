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

Write-Step "enable services"
# Cloudbase-Init is deliberately NOT installed here. Install.ps1 runs before
# the Windows Update passes, and on Server 2025 the monthly checkpoint
# cumulative (applied via UpdateAgent) re-deploys the OS -- software installed
# this early does not reliably survive to the final image. Cloudbase-Init is
# installed in Finalize.ps1 instead, after the last WU pass and right before
# sysprep, where nothing destructive can run after it.
Set-Service -Name QEMU-GA -StartupType Automatic -ErrorAction SilentlyContinue

Write-Step "pin WinRM Basic/unencrypted via Group Policy registry"
# KB4052623 / Defender platform updates (platform 4.18.26040+) reset the
# WinRM service-level AllowUnencrypted and Basic auth settings after each boot.
# Values written to the Policies hive take precedence over the service-level
# WSMAN\Service keys and are not touched by Defender, so this survives every
# subsequent reboot without needing a startup task.
$wmPolicyPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WinRM\Service"
New-Item -Path $wmPolicyPath -Force | Out-Null
Set-ItemProperty -Path $wmPolicyPath -Name "AllowBasic"       -Value 1 -Type DWord -Force
Set-ItemProperty -Path $wmPolicyPath -Name "AllowUnencrypted" -Value 1 -Type DWord -Force
# Immediately re-apply so the current session sees the new policy values.
# Must go through cmd.exe: from PowerShell the @{...} argument is parsed as a
# hashtable and winrm.cmd receives "System.Collections.Hashtable".
cmd.exe /c 'winrm set winrm/config/service @{AllowUnencrypted="true"} >nul 2>&1'
cmd.exe /c 'winrm set winrm/config/service/auth @{Basic="true"} >nul 2>&1'

Write-Step "register WinRM keepalive startup task"
# Belt-and-suspenders: run the winrm set commands at every subsequent startup
# as well, in case a future Defender version learns to clear the Policies hive.
$winrmFixPath = "C:\Windows\System32\packer-winrm-keepalive.ps1"
@'
cmd.exe /c 'winrm set winrm/config/service @{AllowUnencrypted="true"} >nul 2>&1'
cmd.exe /c 'winrm set winrm/config/service/auth @{Basic="true"} >nul 2>&1'
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

# All failure paths above throw; reaching here is success. Explicit exit 0 so a
# stale $LastExitCode from an earlier native command can't fail the provisioner.
exit 0
