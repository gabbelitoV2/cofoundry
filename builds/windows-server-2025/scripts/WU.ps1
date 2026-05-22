$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step($Message) { Write-Host "==> $Message" }

$WUFlag   = "C:\Windows\Temp\tb-wu-done.flag"
$WUScript  = "C:\Windows\Temp\tb-wu.ps1"
$WUTaskName = "TBWindowsUpdate"

# Clear flag from any prior round so this round always does a fresh search.
Remove-Item $WUFlag -Force -ErrorAction SilentlyContinue

# WinRM runs with a restricted network token that blocks the Windows Update COM
# API. Run as SYSTEM via a scheduled task with RunLevel Highest instead.
@'
$ErrorActionPreference = "SilentlyContinue"
$session  = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$found    = $searcher.Search("IsInstalled=0 and Type='Software' and IsHidden=0")
if ($found.Updates.Count -eq 0) {
  Set-Content "C:\Windows\Temp\tb-wu-done.flag" "none"
  exit
}
$dl = $session.CreateUpdateDownloader()
$dl.Updates = $found.Updates
$dl.Download()
$inst = $session.CreateUpdateInstaller()
$inst.Updates = $found.Updates
$inst.Install()
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
$deadline = [DateTime]::Now.AddHours(3)
while (-not (Test-Path $WUFlag) -and [DateTime]::Now -lt $deadline) {
  Start-Sleep 30
}

Unregister-ScheduledTask -TaskName $WUTaskName -Confirm:$false -ErrorAction SilentlyContinue

if (-not (Test-Path $WUFlag)) {
  throw "Windows Update timed out after 3h"
}

$result = (Get-Content $WUFlag).Trim()
if ($result -eq "none") {
  Write-Step "no pending updates"
} else {
  Write-Step "updates installed - Packer restart provisioner will reboot"
}
