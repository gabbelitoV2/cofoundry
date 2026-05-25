# Windows Build Debugging — What Worked and What Didn't

This documents the full debugging journey getting Windows Server builds to work end-to-end under Packer + Proxmox. Kept here so the next person doesn't repeat it.

---

## Problem 1: Invalid OS type for Windows Server 2019

**Symptom:** Proxmox rejected the VM creation with an invalid `ostype`.

**Tried:** `os = "win2k19"` (following the naming pattern of `win2k22`).

**Result:** Proxmox doesn't have a `win2k19` type.

**Fix:** Use `os = "win10"` for Windows Server 2019. Proxmox's OS type list is sparse — 2019 maps to `win10`, 2022 maps to `win2k22`, 2025 maps to `win11`.

---

## Problem 2: VM got an APIPA address (169.254.x.x), WinRM unreachable

**Symptom:** VM booted but got `169.254.x.x` — no DHCP response.

**Root cause:** The VM was attached to `vmbr0` (the main bridge), which has no DHCP server. The default `CF_BRIDGE=vmbr0` env var was being passed to all builds including Windows, overriding the HCL default.

**Fix:**
1. Created a dedicated NAT bridge `vmbr1` with dnsmasq providing DHCP.
2. Added `CF_WIN_BRIDGE` env var so Windows builds use a different bridge from Linux builds.
3. Updated `src/build.ts` to select the bridge based on `recipe.name.startsWith("windows-")`.

---

## Problem 3: VM got a random IP instead of 10.0.0.100

**Symptom:** VM got `10.0.0.193` instead of `10.0.0.100`. Packer's `winrm_host` was hardcoded to `10.0.0.100` so it never connected.

**Root cause:** Stale dnsmasq lease file from a previous VM with a different MAC.

**Fix:**
1. Added a static DHCP reservation in `/etc/dnsmasq.d/vmbr1-nat.conf`: `dhcp-host=02:50:4b:52:57:00,10.0.0.100`.
2. Hardcoded `mac_address = "02:50:4B:52:57:00"` in all Windows HCL files so the build VM always gets the same MAC.
3. Cleared the stale lease file.

---

## Problem 4: UEFI "Press any key to boot from CD" timing

**Symptom:** VM booted to PXE/network boot instead of the Windows installer.

**Root cause:** Packer's `boot_wait = "3s"` then sends `<enter>` once. But on OVMF UEFI with multiple ISOs, the "Press any key" prompt appears on a different device (sata0 VirtIO ISO) before the main boot ISO, creating timing issues.

**Fix:** Spread boot commands over 6 seconds:
```hcl
boot_wait    = "3s"
boot_command = ["<enter><wait><enter><wait><enter><wait><enter><wait><enter><wait><enter>"]
```

---

## Problem 5: Packer waiting forever for WinRM (no QEMU guest agent)

**Symptom:** Packer printed "Waiting for WinRM to become available..." indefinitely.

**Root cause:** By default, the Proxmox plugin uses the QEMU guest agent to discover the VM's IP. Windows has no guest agent during the build phase, so IP discovery never completes.

**Fix:** Hardcode `winrm_host = "10.0.0.100"` in the HCL. Packer skips agent-based IP discovery and connects directly.

---

## Problem 6: WinRM returning HTTP 401 — Basic auth not advertised

**Symptom:** WinRM responded on port 5985 but only offered `WWW-Authenticate: Negotiate`. Packer couldn't authenticate.

This was the most protracted problem. Multiple approaches were tried:

### Attempt A: PowerShell `Set-Item WSMan:\...` in a single FirstLogonCommand
```xml
<CommandLine>powershell -ExecutionPolicy Bypass -Command "Enable-PSRemoting -Force; Set-Item WSMan:\localhost\Service\Auth\Basic -Value true; ..."</CommandLine>
```
**Result:** Failed. `Enable-PSRemoting -Force` resets auth settings to defaults (Basic=false) after they're applied.

### Attempt B: `cmd /c "winrm set winrm/config/service/auth @{Basic="true"}"` (quoted values, outer wrapper)
**Result:** Failed. The inner `"` around `true` closed the outer `cmd /c "..."` quote, breaking the command silently.

### Attempt C: `winrm set ... @{Basic=true}` (unquoted, standalone SynchronousCommand)
**Result:** Failed. `winrm` is a `.cmd` batch script that requires `cmd.exe` and expects quoted values.

### Attempt D: Multiple separate `<SynchronousCommand>` entries
One command per action, no chaining. Using `winrm set winrm/config/service/auth @{Basic=true}` (unquoted).
**Result:** Failed for same reason as C — `winrm.cmd` needs quoted values.

### Attempt E: `cmd.exe /c winrm set winrm/config/service/auth @{Basic="true"}` (no outer wrapper)
The key insight: in XML element content (between `<CommandLine>...</CommandLine>` tags), `"` does **not** need escaping — only `&`, `<`, `>` do. So `@{Basic="true"}` can be written literally, and without an outer `"..."` wrapper, cmd doesn't misparse the inner quotes.

**Result: This worked.**

The final working FirstLogonCommands:
```xml
<SynchronousCommand wcm:action="add">
  <Order>1</Order>
  <CommandLine>cmd.exe /c winrm quickconfig -q</CommandLine>
</SynchronousCommand>
<SynchronousCommand wcm:action="add">
  <Order>2</Order>
  <CommandLine>cmd.exe /c winrm set winrm/config/service @{AllowUnencrypted="true"}</CommandLine>
</SynchronousCommand>
<SynchronousCommand wcm:action="add">
  <Order>3</Order>
  <CommandLine>cmd.exe /c winrm set winrm/config/service/auth @{Basic="true"}</CommandLine>
</SynchronousCommand>
<SynchronousCommand wcm:action="add">
  <Order>4</Order>
  <CommandLine>netsh advfirewall firewall add rule name=WinRM-HTTP dir=in action=allow protocol=TCP localport=5985</CommandLine>
</SynchronousCommand>
```

**Note:** After this fix, `winrm get winrm/config/service/auth` confirmed `Basic = true` and `AllowUnencrypted = true`. Interestingly, WinRM still only advertises `Negotiate` in its HTTP 401 challenge header even when Basic is enabled — it accepts Basic auth but doesn't broadcast it. Packer connects fine regardless.

---

## Problem 7: Cloudbase-Init download failing from inside the VM

**Symptom:** `TemplatePrep.ps1` tried to download `CloudbaseInitSetup_Stable_x64.msi` from GitHub but the download failed with "The connection was closed unexpectedly."

**Diagnosis:** The VM has internet access (HTTP works), but HTTPS to GitHub's CDN fails. This is a TLS handshake issue between Windows Server 2019's default cipher suite negotiation and GitHub's CDN (Fastly/objects.githubusercontent.com).

**Attempts that didn't work:**
- Adding `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12` — same error.
- Switching to `Invoke-WebRequest` — same error, different cmdlet, same underlying .NET TLS stack.
- Using `curl.exe -L --ssl-no-revoke` — downloaded 9 bytes (GitHub returned an error body), because the release asset was renamed from `CloudbaseInitSetup_Stable_x64.msi` to `CloudbaseInitSetup_1_1_8_x64.msi` in v1.1.8.

**Fix:** Pre-download the MSI on the Proxmox host (which has working internet) before the build, then bundle it into the ANSWERFILES CD via Packer's `cd_files`. The VM installs directly from the CD — no internet required.

In `src/build.ts`, before packer runs:
```typescript
const url = await getLatestCloudbaseUrl(); // uses GitHub API
await captureRemote(target, `wget -q -O ${msiDest} "${url}"`);
```

In the HCL `cd_files`:
```hcl
"${path.root}/_shared/CloudbaseInitSetup_x64.msi",
```

`Find-FileOnMedia` in `TemplatePrep.ps1` picks it up from the CD automatically.

---

## Problem 8: Windows Update failing with E_ACCESSDENIED

**Symptom:** `$session.CreateUpdateDownloader()` threw `0x80070005 (E_ACCESSDENIED)`.

**Root cause:** WinRM Basic auth sessions run with a "network" security token. The Windows Update COM API (`Microsoft.Update.Session`) requires a fully elevated "interactive" or "batch" token to create a downloader object. The WinRM session doesn't have this regardless of the user being Administrator.

**Fix:** Catch `[System.UnauthorizedAccessException]` and skip updates gracefully:
```powershell
try {
  $dl = $session.CreateUpdateDownloader()
  ...
} catch [System.UnauthorizedAccessException] {
  Write-Step "Windows Update skipped (insufficient token elevation via WinRM)"
}
```

Windows Updates are not required in the template — they can be applied post-deployment via WSUS or Windows Update on deployed VMs.

---

## Problem 9: "Windows Server installation has failed" during WinPE (Server 2025 only)

**Symptom:** Generic "Windows Server installation has failed" dialog appears immediately during the WinPE install phase. No disk is visible in the installer.

**Root cause:** `autounattend.xml` for Server 2025 was pointing vioscsi and NetKVM driver paths at `2k22\amd64`, but the `packer-virtio-win.iso` on the Proxmox node contains a `2k25` subdirectory (not just `2k22`). Without the correct vioscsi driver, WinPE can't see the virtio-scsi disk and setup fails immediately.

**Verified via:**
```bash
mount -o loop /var/lib/vz/template/iso/packer-virtio-win.iso /tmp/vm
ls /tmp/vm/vioscsi/   # output included: 2k19  2k22  2k25  w10  w11  ...
ls /tmp/vm/vioscsi/2k25/amd64/  # vioscsi.cat  vioscsi.inf  vioscsi.pdb  vioscsi.sys
```

**Fix:** Change all six driver paths in `builds/windows-server-2025/autounattend.xml` from `2k22` → `2k25`:
```xml
<Path>D:\vioscsi\2k25\amd64</Path>
<Path>D:\NetKVM\2k25\amd64</Path>
<!-- (repeated for E:\ and F:\ drive letters) -->
```

**Note:** Server 2019 uses `2k19`, Server 2022 uses `2k22`, Server 2025 uses `2k25`. Match the OS version to its exact subdirectory — do not reuse `2k22` for `2k25` even though they share the same kernel. The virtio-win ISO has separate tested builds for each.
