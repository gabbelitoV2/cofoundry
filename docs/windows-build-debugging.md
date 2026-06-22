# Windows Build Debugging — What Worked and What Didn't

This documents the full debugging journey getting Windows Server builds to work end-to-end under Packer + Proxmox. Kept here so the next person doesn't repeat it.

> **Note (post-refactor):** the hardcoded `10.0.0.100` MAC/IP described in Problem 3 below is no longer how Windows builds work. Each build now gets a unique MAC + IP allocated from a 50-slot pool by `src/build/netslot.ts`, with the dnsmasq reservation written and torn down per-build. Static guarantees from Packer's POV are unchanged (it still sees a known IP up front via `var.build_ip`/`var.build_mac`); the only difference is which IP/MAC. The historical problem entries below are kept for context.

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
const url = await getLatestCloudbaseUrl() // uses GitHub API
await captureRemote(target, `wget -q -O ${msiDest} "${url}"`)
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

---

## Problem 10: "Windows Server installation has failed" — CompactOS WOF copy failure (Server 2025)

**Symptom:** Same "Windows Server installation has failed" dialog. Happens ~8 minutes into setup (after WIM extraction starts), not immediately. VM's disk will show ~11GB written before failure.

**Root cause (confirmed via Panther logs):**
Windows Server 2025 setup auto-enables CompactOS via "policy detection" even when autounattend.xml has no `<Compact>` element (log shows `Compact OS option set to [0]` from unattend, then `CompactOS Enabled via policy detection` overrides it). Once CompactOS is enabled, the WIM is extracted with WOF compression to `$WINDOWS.~BT\NewOS`. DISM then tries to copy `Windows\System32\downlevel\api-ms-win-core-file-l1-2-0.dll` from the staged OS to its work directory to open a new OS session — but the WOF filter driver is not loaded in WinPE, so the compressed file can't be read. The copy fails with `GLE=0x1160`, which surfaces as `Failed to open new OS DISM session. Error: 0x80071160`.

**How to read the logs next time:**

```bash
ssh ${SSH_TARGET}
qm stop 2002 --skiplock 1
modprobe nbd max_part=8
qemu-nbd --read-only --connect=/dev/nbd1 /var/lib/vz/images/2002/vm-2002-disk-1.qcow2
sleep 2
mkdir -p /tmp/winpart && mount -t ntfs3 -o ro /dev/nbd1p3 /tmp/winpart
cat '/tmp/winpart/$Windows.~BT/Sources/Panther/setuperr.log'
grep 'compact\|DISM\|0x80071' '/tmp/winpart/$Windows.~BT/Sources/Panther/setupact.log'
umount /tmp/winpart && qemu-nbd --disconnect /dev/nbd1
```

**What does NOT fix it:**

- Switching vioscsi/NetKVM driver paths between `2k22` and `2k25` (unrelated — those fix disk visibility in early WinPE, not this failure)
- `<Compact>false</Compact>` in autounattend.xml — per existing AGENTS.md note, this causes CBS component store corruption in specialize (different failure mode: "The computer restarted unexpectedly")

**Fix:** Add a `<RunSynchronousCommand>` in the `windowsPE` pass of autounattend.xml to run `compact.exe /CompactOS:never` **before** the WIM is applied. This sets the WinPE registry key that setup's policy detection reads, preventing CompactOS from being auto-enabled:

```xml
<component name="Microsoft-Windows-Setup" ...>
  <RunSynchronous>
    <RunSynchronousCommand wcm:action="add">
      <Order>1</Order>
      <Description>Disable CompactOS before WIM extraction</Description>
      <Path>compact.exe /CompactOS:never</Path>
    </RunSynchronousCommand>
  </RunSynchronous>
  <DiskConfiguration>...</DiskConfiguration>
  ...
</component>
```

This is distinct from the banned `<Compact>false</Compact>` directive — it runs as a shell command before disk partitioning, not as a WIM-extraction flag.

---

## Problem 11: Install.ps1 "disable CompactOS" hangs 20-30 min — root cause confirmed

**Symptom:** Build completes WinPE installation, WinRM connects, Install.ps1 starts, prints "==> disable CompactOS", then hangs for 20-30+ minutes.

**Root cause (confirmed via Panther logs):** MOSETUP (Windows Server 2025's modern setup host, `SetupHost.exe`) does NOT execute `<RunSynchronous>` commands in the `windowsPE` pass before WIM extraction. Zero RunSynchronous log entries appear in the setupact.log between unattend loading and WIM extraction. This means `compact.exe /CompactOS:never` and the `reg add` policy key command in the WinPE `<RunSynchronous>` are completely ignored.

CompactOS policy detection fires at ~09:43:00 in the log and overrides the unattend setting:

```
SetupManager: Detecting CompactOS via policy...
SetupManager: CompactOS Enabled via policy detection.
CSetupPlatform::CreateNewSystem: Creating a compact OS
```

`CompactEvalVolumeSizeMB=32649 MB` (MOSETUP sees ~32 GB even though disk is 40 GB — exact reason unknown, possibly staging/pre-partition evaluation). WIM is then extracted with WOF compression. When Install.ps1 runs `Compact.exe /CompactOS:never`, it must decompress ~14 GB of WOF-compressed files — hence the long hang.

**What does NOT fix it:**

- `compact.exe /CompactOS:never` in the WinPE `<RunSynchronous>` — MOSETUP does not run these before WIM extraction.
- `reg add HKLM\SOFTWARE\Policies\Microsoft\Windows\CompactOS` in WinPE RunSynchronous — same reason.
- Adding `compact.exe /CompactOS:never` to the **specialize** `<RunSynchronous>` (via `Microsoft-Windows-Deployment` component) — CAUSES REGRESSION: triggers DISM failure (`0x80071160 ERROR_FILE_SYSTEM_LIMITATION`) in WinPE. The specialize-pass compact.exe appears to be pre-applied by MOSETUP to the offline staging image in WinPE, conflicting with WOF-compressed files that DISM is trying to access. Manifests as "The computer restarted unexpectedly" dialog (actually a WinPE failure, not specialize CBS).

**Current behavior:** WIM is extracted with CompactOS. Install.ps1's `Compact.exe /CompactOS:never` decompresses the ~14 GB of WOF files. This takes ~20-30 minutes but eventually completes. Do not kill the build — let it run.

**Potential future fix:** The disk size MOSETUP evaluates for CompactOS threshold is ~32 GB despite the disk being 40 GB. Increasing disk to 64G or 80G may push MOSETUP's evaluated size above its CompactOS threshold. This would prevent WOF compression during WIM extraction and eliminate the decompression step entirely.

---

## Problem 12: WinRM 401 "invalid content type" after first reboot (post-VirtIO)

**Symptom:** Build succeeds through Install.ps1 and the first `windows-restart`. Packer prints "Machine successfully restarted, moving on", then immediately fails with:

```
Error uploading file ...: Couldn't create shell: http response error: 401 - invalid content type
```

**Root cause:** The `PackerWinRMKeepalive` startup task included `winrm quickconfig -q -force`. On boot, Defender resets WinRM auth (Basic and AllowUnencrypted back to disabled). The keepalive task is supposed to re-enable them. However, WinRM auth settings **persist in the registry across reboots** — so when the restart provisioner reconnects, Basic auth is still enabled from the previous session. The restart provisioner succeeds and prints "moving on". Then quickconfig (from the keepalive task, which is still running in the background as a startup task) fires and causes a brief WinRM service disruption or configuration reset, right as the PowerShell provisioner creates its first shell. The 401 response contains HTML instead of SOAP XML ("invalid content type"), which happens when WinRM rejects Basic auth.

**What confirmed it:** After the failed build (with `--keep-vm`), WinRM was checked from the Proxmox host:

```
curl -X POST http://10.0.0.100:5985/wsman ...
# Response: WWW-Authenticate: Basic realm="WSMAN"  ← keepalive task eventually ran
```

Basic auth was available _after_ the failure — meaning the keepalive task ran successfully but too late.

**Fix:** Remove `winrm quickconfig -q -force` from the keepalive task in all three `Install.ps1` scripts. `winrm quickconfig` is redundant — WinRM was already configured to auto-start by `FirstLogonCommands` in autounattend.xml. The two `winrm set` commands are sufficient to re-enable Basic auth without touching the service state. Applied to `windows-server-2019`, `windows-server-2022`, and `windows-server-2025`.

---

## Problem 13: "The computer restarted unexpectedly" — WinPE crash from RunSynchronous compact.exe

**Symptom:** The "The computer restarted unexpectedly or encountered an unexpected error" dialog appears consistently. No Panther logs are written to disk at all (`$Windows.~BT/Sources/Panther/` does not exist).

**Diagnosis:** When Panther logs are absent but the partition table and `$Windows.~BT/Drivers/Unattend/` exist, the crash is happening after disk partitioning but before WIM extraction — exactly when `RunSynchronous` commands in the `windowsPE` unattend pass execute.

**Root cause:** `RunSynchronous` commands were added to the `windowsPE` pass of `autounattend.xml` (a `reg add` to set CompactOS policy, then `compact.exe /CompactOS:never`). Problem 11 had concluded these are "silently ignored" by MOSETUP, based on Panther log analysis. That conclusion was wrong or context-dependent: when the crash happens during RunSynchronous execution itself, Panther hasn't started writing yet, so there are no logs to show zero RunSynchronous entries. `compact.exe /CompactOS:never` in WinPE crashes the setup process — likely because the WOF filter driver isn't loaded in the WinPE RAM disk environment and compact.exe faults rather than returning an error.

**What does NOT fix it:**

- `reg add HKLM\SOFTWARE\Policies\Microsoft\Windows\CompactOS` in WinPE RunSynchronous — this one is probably safe but irrelevant (modifies WinPE's RAM HKLM, not the target OS)
- `compact.exe /CompactOS:never` in WinPE RunSynchronous — **this causes the crash**

**Fix:** Remove the entire `<RunSynchronous>` block from the `windowsPE` component in `autounattend.xml`. The CompactOS mitigation belongs in `Install.ps1` (which runs `Compact.exe /CompactOS:never` after the OS is booted), not in WinPE.

---

## Problem 14: "Windows Server installation has failed" — invalid CompactOS value in setupconfig.ini

**Symptom:** "Windows Server installation has failed" dialog. The disk has NO partition table at all (sgdisk shows an empty GPT). This is earlier than Problem 10 (which shows ~11 GB written and no Panther) — here nothing was written to the OS partition.

**Diagnosis:** The ANSWERFILES CD contains a `setupconfig.ini` alongside `autounattend.xml`. Windows Setup reads `setupconfig.ini` from the same media root as `autounattend.xml`. If `setupconfig.ini` contains an invalid option value, setup aborts before it reaches disk partitioning.

**Root cause:** `setupconfig.ini` contained `CompactOS=disable`. The valid values for the `/CompactOS` setup option are `Always` and `Never` (not `disable`). An unrecognized value causes setup to fail before creating any partitions.

**How to diagnose:** Stop the VM mid-failure, connect the disk via nbd, and check whether the partition table is empty:

```bash
qemu-nbd --read-only --connect=/dev/nbd1 /var/lib/vz/images/2002/vm-2002-disk-1.qcow2
sleep 2
sgdisk -p /dev/nbd1   # if "no partitions" → failure was before disk partitioning
```

If there are no partitions and $Windows.~BT doesn't exist (or only Drivers/Unattend does from a _previous_ stale nbd session), the failure is pre-partitioning — check setupconfig.ini syntax.

**Fix:** Change `CompactOS=disable` → `CompactOS=Never` in `builds/windows-server-2025/setupconfig.ini`.

**Caveat:** `CompactOS=Never` in setupconfig.ini gets past the pre-partition crash but does NOT actually prevent CompactOS — see Problem 15.

---

## Problem 15: "Windows Server installation has failed" — CompactOS policy always wins, WOF not loaded in WinPE (current blocker)

**Symptom:** Same "Windows Server installation has failed" dialog, ~11 GB written to disk. Panther logs exist. Disk IS partitioned (Problem 14 is fixed).

**Root error (from `setuperr.log`):**

```
CSetBootCommand::DoExecute: Failed to open new OS DISM session. Error: 0x80071160
DISM Manager: PID=1356 TID=888 Failed to copy inbox forwarders to the temporary location.
CDISMManager::CreateImageSessionFromLocation(hr:0x80071160)
```

`0x80071160 = ERROR_FILE_SYSTEM_LIMITATION` — WOF (Windows Overlay Filter) compressed files can't be read without the WOF kernel driver loaded.

**Root cause (confirmed from `setupact.log`):**

```
Unattend Compact: No Value Found          ← setupconfig.ini CompactOS=Never is NOT read
Compact OS option set to [0]              ← unattend says no compact
SetupManager: Detecting CompactOS via policy...
SetupManager: CompactOS Enabled via policy detection.   ← policy overrides
CompactEvalVolumeSizeMB = 0x6389 (25481 MB ≈ 24.9 GiB)
CompactEvalPolicyFlags  = 0x8   ← only bit 3 set
CompactEvalSystemPolicy = 0x5   ← compact = enabled
Apply WIM file PathForNewOSFile (compact), index 4 to G:\$WINDOWS.~BT\NewOS  [SUCCESS, 7:47]
DISM Manager: Failed to copy inbox forwarders to the temporary location.      [FAIL, 0x80071160]
```

Windows Server 2025's MOSETUP always enables CompactOS via policy detection (likely a server-SKU policy, `CompactEvalPolicyFlags = 0x8`). The WIM is extracted with WOF compression to `G:\$WINDOWS.~BT\NewOS`. DISM then tries to open an offline session from that staging dir to set up the boot command, which requires copying `downlevel\api-ms-win-*.dll` inbox forwarders. These DLLs are now WOF-compressed. WinPE does not load wof.sys as a kernel driver, so any Win32 file operation against a WOF-compressed file returns `ERROR_FILE_SYSTEM_LIMITATION`.

**What does NOT fix it:**

- `setupconfig.ini` with `CompactOS=Never` — MOSETUP does not read this file from the ANSWERFILES CD; log shows "No Value Found" for UnattendCompact
- Any disk size tried (25G or 40G) — policy-based compact fires regardless; `CompactEvalVolumeSizeMB` for 25G = 25481 MB, for 40G = 32649 MB (from Problem 11)
- `<Compact>false</Compact>` in autounattend.xml `<OSImage>` — causes COMPONENTS hive TxR corruption → "The computer restarted unexpectedly" (per AGENTS.md; not yet retested on current ISO)
- `RunSynchronous compact.exe` in windowsPE pass — crashes WinPE (Problem 13)

**Approaches not yet tried (as of 2026-05-25):**

1. Very large disk (64–80G) to see if there's a size above which policy-based CompactOS doesn't fire
2. Remove `discard = true` from the HCL disk block — if CompactEvalPolicyFlags bit 3 = "SSD/TRIM storage", removing SCSI UNMAP might make MOSETUP classify the disk as HDD and skip CompactOS
3. Retry `<Compact>false</Compact>` with the current ISO version — CBS corruption was observed previously but the ISO is updated periodically

**Current approach (2026-05-25):** Trying `<Compact>false</Compact>` in `<OSImage>` with a 32G disk. This suppresses WOF compression so DISM can read files in WinPE. The CBS corruption risk from AGENTS.md is accepted as the only remaining option — if it manifests as "The computer restarted unexpectedly" in specialize, the ISO hasn't fixed that bug.

---

## Problem 16: WU.ps1 fails with CommandNotFoundException on temp script path (WinRM race condition)

**Symptom:** After the first WU.ps1 round installs updates and the `windows-restart` provisioner reboots the VM, the second WU.ps1 run immediately fails:

```
& : The term 'c:/Windows/Temp/script-6a15dad3-5a2d-a895-64ac-f316b3b0c9c2.ps1' is not recognized
as the name of a cmdlet, function, script file, or operable program.
```

The build does not abort — the `windows-restart` provisioner after WU.ps1 still fires, and the subsequent WU.ps1 run succeeds normally.

**Root cause:** Packer's WinRM PowerShell provisioner works by uploading the script to `c:/Windows/Temp/script-<uuid>.ps1` and immediately executing it via `& 'path'`. After a post-update reboot (especially one that involves Windows applying patches on first boot), WinRM reconnects before the filesystem is fully settled. The file is uploaded successfully but the temp path is not yet accessible when the execute command runs.

This is most likely on the WU.ps1 call that immediately follows the first update round reboot — that reboot involves Windows doing post-update finalization work on first boot, which makes the OS slower to stabilize than a plain restart.

**Fix:** Add `pause_before = "30s"` to the PowerShell provisioners that follow a `windows-restart`. This tells Packer to wait 30 seconds after WinRM reconnects before uploading and executing the script:

```hcl
provisioner "powershell" {
  pause_before = "30s"
  script       = "${path.root}/windows-server-2025/scripts/WU.ps1"
}
```

Applied to all three WU.ps1 provisioner steps in `windows-server-2025.pkr.hcl` that follow a `windows-restart`. If the race condition recurs, bump to `60s`.

---

## Problem 17: Server 2025 cumulative update re-deploys the OS (creates `C:\Windows.old`) — Cloudbase-Init install moved to Finalize

**Symptom / concern:** Software installed in `Install.ps1` (which runs _before_ the Windows Update passes) was suspected not to survive into the final image, because Server 2025 appeared to "reset" itself during the WU passes.

**Root cause:** On Windows Server 2025, a large cumulative update (LCU) is applied via UpdateAgent as a near-full **OS re-deploy** — it lays down a fresh OS and creates `C:\Windows.old`. Crucially this happens for an ordinary cumulative, i.e. a _revision_ bump within the same base build (e.g. `26100.32230 → 26100.32995` via KB5094125), **not** only for a feature/version upgrade. This is Server 2025's checkpoint-cumulative servicing model. The common "an LCU never creates `Windows.old`" intuition is **wrong for Server 2025.**

**Empirically verified (build on 2026-06-21, instrumented with a probe + offline artifact inspection):**

- `C:\Windows.old` **is** created by the cumulative — confirmed both mid-WU and at Finalize.
- But `C:\Windows.old` ends up **empty (0 bytes)** by Finalize time — the servicing reboot empties it. **There is nothing to clean up; do not add a `Windows.old` removal step** (it would reclaim nothing). The `0 GB` reading is real, not an ACL artifact.
- Pre-WU software **survived** the re-deploy: QEMU-GA (installed in `Install.ps1`) was present in the final image. So the re-deploy did **not** wipe installed software in this run — it's disk churn, not data loss.

**Fix / decision:** Install **Cloudbase-Init in `Finalize.ps1`** (after the last WU pass, immediately before sysprep) instead of `Install.ps1`. This is belt-and-suspenders: it guarantees the cloud-init agent is present in the exported template regardless of any re-deploy, since nothing destructive runs between that install and the vzdump. VirtIO/QEMU-GA stay in `Install.ps1` (they're needed earlier and were observed to survive).

**Production note:** A deployed clone ships fully patched at a GA build, so routine **monthly** CUs keep it current without drama. A large **catch-up** CU (e.g. a long-unpatched VM) can trigger the re-deploy, but installed software survived it in testing — so this is not a data-loss event for end users, and there is no recurring "Cloudbase-Init gets deleted on update" risk.

**How to measure deadweight in an exported artifact (offline, ignores Windows ACLs):**

```bash
ssh ${SSH_TARGET}
M=/var/lib/vz/dump/measure; mkdir -p $M
zstd -dc /var/lib/vz/dump/cofoundry-out/<name>.vma.zst > $M/d.vma
vma extract $M/d.vma $M/out
modprobe nbd max_part=8
qemu-nbd -r -c /dev/nbd0 $M/out/disk-drive-scsi0.raw
mount -o ro -t ntfs-3g /dev/nbd0p3 /mnt/win    # p3 = Windows C: volume
du -shx /mnt/win/* | sort -rh                  # top-level breakdown
umount /mnt/win; qemu-nbd -d /dev/nbd0; rm -rf $M
```

For reference, a 2026-06 Server 2025 build was 17 GB used → 8.6 GB compressed: ~12 GB `WinSxS` (mostly hardlinked, irreducible after `/ResetBase`), the rest legitimate software + Defender. The only cleanly-reclaimable items are WinRE `Winre.wim` (~670 MB, `reagentc /disable`) and `WinSxS\Backup` (~200 MB) — judged not worth removing.

---

## Problem 18: VM stuck at "no bootable device" — OVMF boot-prompt window missed on a loaded node

**Symptom:** Packer hangs on "Waiting for WinRM to become available..." indefinitely. A console screenshot shows:

```
Press any key to boot from CD or DVD......
BdsDxe: No bootable option or device was found.
BdsDxe: Press any key to enter the Boot Manager Menu.
```

The VM never started installing (disk writes stay near zero); it eventually fails after `winrm_timeout` (4h).

**Root cause:** The OVMF "Press any key to boot from CD or DVD" prompt is a short (~5s) window whose **start time drifts with POST speed**. The old `boot_wait = "3s"` + 10 `<enter>`s at `<wait2>` only covered roughly t≈3–23s. On a busy node, POST is slow enough that the prompt appears _after_ the last keypress, so every press misses and the firmware falls through to "no bootable device." (This supersedes the timing tuning in Problem 4 — same failure, more aggressive POST drift.)

**Fix:** Widen the keypress blanket so a slow POST can't fall outside it — `boot_wait = "2s"` + 30 `<enter>`s at `<wait2>` (covers t≈2–62s). Applied to all three Windows recipes. Stray `<enter>`s during WinPE load are harmless (autounattend drives Setup non-interactively).

**Rescue an already-stuck build without restarting it** (Packer is still waiting for WinRM, so the unattended install will proceed once it boots):

```bash
ssh ${SSH_TARGET}
qm reset <vmid>
sleep 4
for i in $(seq 1 14); do echo "sendkey ret" | qm monitor <vmid> >/dev/null; sleep 1; done
# confirm install started: diskwrite should climb
qm status <vmid> --verbose | grep -E '^diskwrite'
```

Console screenshot for diagnosis: `echo "screendump /tmp/x.ppm" | qm monitor <vmid>` then convert with `pnmtopng` and copy off the node.

---

## Problem 19: Fixed build VMID keeps same-recipe builds sharing VM state

**Symptom / risk:** Even after stale packer pre-cleaning, every recipe still used one fixed `build_vmid` in its HCL (`windows-server-2025` = `2002`). A cancelled CI run can leave node-side packer/watchdog processes alive; a later same-recipe build cleans them, but the design still centers all attempts on the same Proxmox VMID and makes overlap between local and CI builds disruptive.

**Root cause:** The NAT build network already had a per-build slot allocator for IP/MAC, but the Proxmox VMID stayed static in each recipe. That meant stale process cleanup and live builds targeted the same VM object by default.

**Fix tried (2026-06-22):** Make `build_vmid` a Packer variable in all templates, preserve the existing fixed value as the manual-Packer default, and have `cf build` pass a slot-derived VMID (`recipe build_vmid * 100 + slotIndex`) whenever a build slot is allocated. The pre-clean now removes stale recipe-local packers, then destroys both the legacy fixed VMID and the current slot-derived VMID for transition safety.

**Expected result:** Same-recipe runs no longer share VMID `2002`; for example, `windows-server-2025` slot 0 builds as VMID `200200`, slot 1 as `200201`, etc. This removes the fixed-VM shared-state hazard. It does not prove or disprove the remaining specialize-pass `COMPONENTS` hive corruption theory; if that still occurs on a clean dynamic-VMID run, the host/RAM or storage-integrity suspect remains.

**Test result:** Pending CI workflow dispatch after commit.
