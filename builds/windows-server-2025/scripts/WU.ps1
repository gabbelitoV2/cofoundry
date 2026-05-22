$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step($Message) { Write-Host "==> $Message" }

$WUFlag    = "C:\Windows\Temp\tb-wu-done.flag"
$WULog     = "C:\Windows\Temp\tb-wu.log"
$WUScript  = "C:\Windows\Temp\tb-wu.ps1"
$WUTaskName = "TBWindowsUpdate"

# Clear state from any prior round.
Remove-Item $WUFlag -Force -ErrorAction SilentlyContinue
Remove-Item $WULog  -Force -ErrorAction SilentlyContinue

# WinRM runs with a restricted network token that blocks the Windows Update COM
# API. Run as SYSTEM via a scheduled task with RunLevel Highest instead.
# The task writes progress lines to $WULog so the outer loop can tail them.
@'
function Log($msg) { Add-Content "C:\Windows\Temp\tb-wu.log" "[$(Get-Date -Format 'HH:mm:ss')] $msg" }

Log "searching for updates..."
$session  = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
try {
  $found = $searcher.Search("IsInstalled=0 and Type='Software' and IsHidden=0")
} catch {
  Log "search failed: $_"
  Set-Content "C:\Windows\Temp\tb-wu-done.flag" "none"
  exit
}
if ($found.Updates.Count -eq 0) {
  Log "no pending updates"
  Set-Content "C:\Windows\Temp\tb-wu-done.flag" "none"
  exit
}
$total = $found.Updates.Count
Log "found $total update(s) - downloading..."
$dl = $session.CreateUpdateDownloader()
$dl.Updates = $found.Updates
$dl.Download()
Log "download complete - installing..."
$inst = $session.CreateUpdateInstaller()
for ($i = 0; $i -lt $total; $i++) {
  Log "  [$($i+1)/$total] $($found.Updates.Item($i).Title)"
  $single = New-Object -ComObject Microsoft.Update.UpdateColl
  $single.Add($found.Updates.Item($i)) | Out-Null
  $inst.Updates = $single
  $inst.Install() | Out-Null
}
Log "all updates installed"
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

  # Tail new lines from the progress log.
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

# Flush any remaining log lines.
if (Test-Path $WULog) {
  $lines = Get-Content $WULog
  if ($lines.Count -gt $logOffset) {
    $lines[$logOffset..($lines.Count - 1)] | ForEach-Object { Write-Host "    $_" }
  }
}

if (-not (Test-Path $WUFlag)) {
  throw "Windows Update timed out after 3h"
}

$result = (Get-Content $WUFlag).Trim()
if ($result -eq "none") {
  Write-Step "no pending updates"
} else {
  Write-Step "updates installed - Packer restart provisioner will reboot"
}
