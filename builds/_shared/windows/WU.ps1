$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step($Message) { Write-Host "==> $Message" }

$WUFlag       = "C:\Windows\Temp\tb-wu-done.flag"
$WURebootFlag = "C:\Windows\Temp\tb-wu-reboot.flag"
$WULog        = "C:\Windows\Temp\tb-wu.log"
$WUScript     = "C:\Windows\Temp\tb-wu.ps1"
$WUTaskName   = "TBWindowsUpdate"

# Clear state from any prior round. The reboot flag is preserved across the WU
# provisioner and read by the conditional restart_command in the recipe.
Remove-Item $WUFlag       -Force -ErrorAction SilentlyContinue
Remove-Item $WURebootFlag -Force -ErrorAction SilentlyContinue
Remove-Item $WULog        -Force -ErrorAction SilentlyContinue

# WinRM runs with a restricted network token that blocks the Windows Update COM
# API. Run as SYSTEM via a scheduled task with RunLevel Highest instead.
#
# The task loops internally: search -> batched download -> batched install ->
# pending-reboot check. It exits when there's nothing left to install OR when a
# reboot is required, so packer can perform the reboot and re-invoke this
# script for another round.
@'
function Log($msg) { Add-Content "C:\Windows\Temp\tb-wu.log" "[$(Get-Date -Format 'HH:mm:ss')] $msg" }

function Test-PendingReboot {
  if (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending") { return $true }
  if (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired") { return $true }
  $sm = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager" -ErrorAction SilentlyContinue
  if ($sm -and $sm.PSObject.Properties.Name -contains "PendingFileRenameOperations") { return $true }
  try {
    $si = New-Object -ComObject Microsoft.Update.SystemInfo
    if ($si.RebootRequired) { return $true }
  } catch {}
  return $false
}

$session = New-Object -ComObject Microsoft.Update.Session
$totalInstalled = 0
$maxIterations  = 5

for ($iter = 1; $iter -le $maxIterations; $iter++) {
  Log "iteration $iter - searching for updates..."
  $searcher = $session.CreateUpdateSearcher()
  try {
    # IsInstalled=0: not yet installed. Type=Software: skip drivers (template should
    # stay generic). IsHidden=0: skip anything an admin would have hidden. We do NOT
    # filter on BrowseOnly here — that excludes legitimate optional updates that
    # may be required for cumulative chains.
    $found = $searcher.Search("IsInstalled=0 and Type='Software' and IsHidden=0")
  } catch {
    Log "search failed: $_"
    break
  }

  if ($found.Updates.Count -eq 0) {
    Log "no pending updates"
    break
  }

  $total = $found.Updates.Count
  Log "found $total update(s):"
  for ($i = 0; $i -lt $total; $i++) { Log "  - $($found.Updates.Item($i).Title)" }

  # Accept EULAs (some optional/feature updates require this before download).
  for ($i = 0; $i -lt $total; $i++) {
    $u = $found.Updates.Item($i)
    if (-not $u.EulaAccepted) { try { $u.AcceptEula() } catch {} }
  }

  Log "downloading $total update(s) in one batch..."
  $dl = $session.CreateUpdateDownloader()
  $dl.Updates = $found.Updates
  try {
    $dlResult = $dl.Download()
    Log "  download result: HResult=$($dlResult.HResult) ResultCode=$($dlResult.ResultCode)"
  } catch {
    Log "download failed: $_"
    break
  }

  # Only install updates that actually downloaded.
  $toInstall = New-Object -ComObject Microsoft.Update.UpdateColl
  for ($i = 0; $i -lt $total; $i++) {
    if ($found.Updates.Item($i).IsDownloaded) { [void]$toInstall.Add($found.Updates.Item($i)) }
  }
  if ($toInstall.Count -eq 0) {
    Log "nothing downloaded successfully - aborting iteration"
    break
  }

  Log "installing $($toInstall.Count) update(s) in one batch..."
  $inst = $session.CreateUpdateInstaller()
  $inst.Updates = $toInstall
  try {
    $instResult = $inst.Install()
    Log "  install result: HResult=$($instResult.HResult) ResultCode=$($instResult.ResultCode) RebootRequired=$($instResult.RebootRequired)"
  } catch {
    Log "install failed: $_"
    break
  }

  # Per-update result codes (2=Succeeded, 3=SucceededWithErrors, 4=Failed, 5=Aborted).
  for ($i = 0; $i -lt $toInstall.Count; $i++) {
    $r = $instResult.GetUpdateResult($i)
    Log "    [$($i+1)/$($toInstall.Count)] code=$($r.ResultCode) hr=$($r.HResult)  $($toInstall.Item($i).Title)"
    if ($r.ResultCode -eq 2 -or $r.ResultCode -eq 3) { $totalInstalled++ }
  }

  if ($instResult.RebootRequired -or (Test-PendingReboot)) {
    Log "reboot required - exiting loop so packer can restart"
    Set-Content "C:\Windows\Temp\tb-wu-reboot.flag" "needed"
    break
  }

  Log "no reboot required - looping to check for further updates"
}

Log "round complete; installed $totalInstalled update(s) this invocation"
if (Test-PendingReboot -and -not (Test-Path "C:\Windows\Temp\tb-wu-reboot.flag")) {
  Set-Content "C:\Windows\Temp\tb-wu-reboot.flag" "needed"
}
Set-Content "C:\Windows\Temp\tb-wu-done.flag" "done"
'@ | Set-Content $WUScript -Encoding UTF8

$action    = New-ScheduledTaskAction -Execute "powershell.exe" `
               -Argument "-ExecutionPolicy Bypass -NonInteractive -File `"$WUScript`""
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 3)
Register-ScheduledTask -TaskName $WUTaskName -Action $action `
  -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $WUTaskName

Write-Step "waiting for Windows Update round to complete..."
$deadline  = [DateTime]::Now.AddHours(3)
$start     = [DateTime]::Now
$logOffset = 0

while (-not (Test-Path $WUFlag) -and [DateTime]::Now -lt $deadline) {
  Start-Sleep 30

  if (Test-Path $WULog) {
    $lines = Get-Content $WULog
    if ($lines.Count -gt $logOffset) {
      $lines[$logOffset..($lines.Count - 1)] | ForEach-Object { Write-Host "    $_" }
      $logOffset = $lines.Count
    }
  }

  $elapsed = [DateTime]::Now - $start
  Write-Host "    (elapsed $([int]$elapsed.TotalMinutes)m, waiting...)"
}

Unregister-ScheduledTask -TaskName $WUTaskName -Confirm:$false -ErrorAction SilentlyContinue

if (Test-Path $WULog) {
  $lines = Get-Content $WULog
  if ($lines.Count -gt $logOffset) {
    $lines[$logOffset..($lines.Count - 1)] | ForEach-Object { Write-Host "    $_" }
  }
}

if (-not (Test-Path $WUFlag)) {
  throw "Windows Update timed out after 3h"
}

if (Test-Path $WURebootFlag) {
  Write-Step "updates installed - reboot required (conditional windows-restart will reboot)"
} else {
  Write-Step "no reboot required - conditional windows-restart will skip"
}
