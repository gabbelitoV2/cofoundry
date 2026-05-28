$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step($Message) { Write-Host "==> $Message" }

Write-Step "disable hibernation (deletes hiberfil.sys)"
& powercfg.exe -h off

Write-Step "disable pagefile (pagefile.sys is freed by the windows-restart that follows)"
# Finalize.ps1 re-enables AutomaticManagedPagefile=true before sysprep so the
# cloned VM regenerates a correctly-sized pagefile.sys on first boot. The
# disable here is only in effect for the zero-free-space pass.
$cs = Get-CimInstance -ClassName Win32_ComputerSystem
if ($cs.AutomaticManagedPagefile) {
  Set-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = $false }
}
Get-CimInstance -ClassName Win32_PageFileSetting -ErrorAction SilentlyContinue |
  Remove-CimInstance -ErrorAction SilentlyContinue
