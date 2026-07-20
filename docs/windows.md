# Windows Server recipes

This document is the source of truth for Windows recipe configuration and
debugging. Update the relevant section when a new experiment changes what is
known, including when an attempted fix fails.

## Recipe matrix

| Recipe                | Proxmox `ostype` | VirtIO directory | TPM 2.0 | Final disk | Answer-file exception      |
| --------------------- | ---------------- | ---------------- | ------: | ---------: | -------------------------- |
| `windows-server-2019` | `win10`          | `2k19`           |      No |        30G | None                       |
| `windows-server-2022` | `win11`          | `2k22`           |     Yes |        30G | None                       |
| `windows-server-2025` | `win11`          | `2k25`           |     Yes |        32G | `<Compact>false</Compact>` |

The release-specific ISO URL, image name, and VirtIO directory must also match
the selected Windows release. Other settings should remain aligned unless a
documented installer requirement says otherwise.

## Proxmox OS type

Never derive an `ostype` by inventing a value from a Windows release name.
Check the current Proxmox `qemu-server` schema before changing a recipe.

The enum was verified directly on the configured Proxmox 9.1.18 build node and
against upstream `qemu-server` 9.2.0:

```text
other wxp w2k w2k3 w2k8 wvista win7 win8 win10 win11 l24 l26 solaris
```

There is no `win2k19`, `win2k22`, or `win2k25`. Proxmox maps:

- Windows Server 2019 to `win10`;
- Windows Server 2022 and 2025 to `win11`.

The upstream definition is the
[`ostype` schema in Proxmox qemu-server`](https://github.com/proxmox/qemu-server/blob/b69480d6110c005b9eb936c55c0438607d10975b/src/PVE/QemuServer.pm#L365-L387).
The Packer Proxmox plugin passes its `os` value to the Proxmox API. Its generated
field description has historically lagged the Proxmox enum, so Proxmox is the
source of truth.

## Shared configuration

All three recipes intentionally share:

- OVMF, Q35, host CPU, 4 cores, and 8 GiB RAM;
- VirtIO SCSI with discard and an I/O thread;
- a 100G temporary build disk for installation and servicing headroom;
- the NAT build network, per-build DHCP slot, and slot-derived VMID;
- the wide OVMF boot-key window;
- WinRM on the allocated IP with a 45-minute initial timeout;
- the shared install, update, pre-finalize, finalize, shrink, and export scripts.

The temporary disk is reduced before export. `Finalize.ps1` shrinks the Windows
partition, then the host-side post-processor truncates the virtual disk to the
declared final size. The `# final_disk_size` metadata and
`local.final_disk_size` must match.

For networked builds, `cf` derives the live VMID as
`base_build_vmid * 100 + slot_index`. The HCL base remains the default for a
manual Packer invocation. Find failed builds by `packer-<recipe>` name rather
than assuming a fixed VMID.

## Windows Server 2025

Server 2025 requires:

- Proxmox `ostype = "win11"`;
- `cpu_type = "host"` so setup can see SSE4.1/4.2;
- TPM 2.0;
- `2k25` VirtIO storage and network drivers;
- a 32G final disk;
- `<Compact>false</Compact>` in `autounattend.xml`.

### CompactOS decision

This ISO repeatedly selected a compact apply when the answer file omitted
`<Compact>false>`. The apply then failed deterministically during servicing with
phase 71 / DISM `0x80071160`. A 64G disk did not change that policy decision.

`<Compact>false>` allows setup to reach specialize and complete, but an
intermittent specialize-pass component-store failure has also been observed.
Bounded Windows build retries tolerate that flake. `Install.ps1` still begins
with `Compact.exe /CompactOS:never` as a post-boot safety check.

Do not add CompactOS commands to `windowsPE` or `specialize`. The attempted
variants either crashed early WinPE, were ineffective, or triggered the same
DISM filesystem-limitation failure against the staged image.

## Build flow

1. `autounattend.xml` loads the release-matched VirtIO storage and network
   drivers and installs the Datacenter image.
2. First-logon commands enable WinRM Basic authentication and unencrypted HTTP
   for the Packer session.
3. `Install.ps1` disables CompactOS, installs VirtIO guest tools, verifies
   QEMU-GA, and pins WinRM through the update reboots.
4. Two Windows Update rounds run as a SYSTEM scheduled task. Packer performs a
   conditional reboot after each round.
5. `PreFinalize.ps1` disables hibernation and the pagefile for compaction.
6. `Finalize.ps1` cleans the component store, installs Cloudbase-Init, shrinks
   the partition, zeros free space, removes temporary WinRM settings, and runs
   sysprep.
7. The host truncates the disk, creates the vzdump artifact, and destroys the
   build VM.

### Windows Update automatic reboot suppression

Windows Update's own Update Orchestrator will auto-restart the VM when a
servicing operation is pending. On Server 2025 the checkpoint cumulative leaves
such an operation pending after the first WU round, and the orchestrator fires
the restart a few minutes into the **second** round — while `WU.ps1`'s SYSTEM
task is still scanning. Because the build is headless (WinRM, no interactive
user), nothing defers that restart: the VM reboots out from under the running
powershell provisioner, Packer reports `Script exited with non-zero exit status:
1`, and `Builds finished but no artifacts were created`. This reproduced on all
three build attempts, so `CF_BUILD_ATTEMPTS` did not rescue it — every attempt
died the same way in round two.

`WU.ps1` already installs every update explicitly through the WUA COM API and
signals `RebootRequired` back to Packer, which owns every restart through
`windows-restart`. The orchestrator's *automatic* install/reboot is therefore
pure interference during the build. `Install.ps1` disables it for the build's
duration by writing the `...\WindowsUpdate\AU` policy (`NoAutoUpdate=1`,
`NoAutoRebootWithLoggedOnUsers=1`) and disabling the
`\Microsoft\Windows\UpdateOrchestrator\Reboot*` tasks. `NoAutoUpdate` does not
affect the explicit COM install path. `Finalize.ps1` removes the policy key and
re-enables the reboot tasks before sysprep, so the shipped template keeps
Windows' default update policy rather than inheriting a "never auto-reboot"
state.

Status: **unverified on a live build** at time of writing. Confirm on the next
real run that both WU rounds complete without a mid-round reboot and record the
outcome here. If a mid-round reboot still occurs, the `Reboot*` task disable was
likely denied (TrustedInstaller-owned) — capture whether `NoAutoUpdate` alone
held, and whether the reboot came from the orchestrator or from a boot-time
servicing commit (the latter would need a different approach, e.g. settling the
servicing stack before each round rather than suppressing auto-reboot).

Cloudbase-Init is deliberately installed after Windows Update. Server 2025
checkpoint cumulative updates can perform a near-full OS redeploy and create
`C:\Windows.old`. Installed software survived the observed redeploy, but the
late install guarantees Cloudbase-Init is present immediately before export.
The observed `Windows.old` directory was empty by finalization, so no cleanup
step is needed.

### Windows Update progress reporting

The SYSTEM update task in `WU.ps1` downloads and installs each batch through the
**asynchronous** `IUpdateDownloader.BeginDownload` / `IUpdateInstaller.BeginInstall`
COM methods and polls the returned job's `GetProgress().PercentComplete`, logging
each 5% step (or at least once a minute) to `tb-wu.log`. The outer script already
tails that log to Packer, so a long cumulative update now shows a climbing
percentage instead of only the elapsed-minute heartbeat. Batching is unchanged —
`Begin*` runs the same update collection the synchronous calls did.

`Begin*` requires COM progress/completed callback objects. `WU.ps1` supplies
minimal no-op callbacks defined via `Add-Type`; their interface IIDs are taken
verbatim from `wuapi.idl` (`IDownloadProgressChangedCallback`
`8c3f1cdd-6173-4591-aebd-a56a53ca77c1`, `IDownloadCompletedCallback`
`77254866-9f5b-4c8e-b9e2-c77a8530d64b`, `IInstallationProgressChangedCallback`
`e01402d5-f8da-43ba-a012-38894bd048f1`, `IInstallationCompletedCallback`
`45f4f6f3-d602-4f98-9a8a-3efa152ad2d3`). If the types fail to compile or `Begin*`
throws (e.g. a wrong IID or marshaling mismatch), the code falls back to the
original synchronous `Download()` / `Install()` batch call, so a callback problem
can only lose the progress readout for a round — it cannot fail the build.

Status: **unverified on a live build** at time of writing. The async-callback
path could not be exercised from the dev host; confirm on the next real run that
the log shows `download`/`install` percentages rather than the
`async ... unavailable ... using synchronous batch` fallback line, and record the
outcome here.

### Windows Update throughput mode

Windows servicing is intentionally conservative on interactive machines, and
Task Scheduler creates tasks at priority 7 (below normal) by default. The build
VM has no interactive workload during its update rounds, so `WU.ps1` registers
the SYSTEM task at priority 4 (normal) and temporarily selects the High
performance power scheme. It records the prior scheme and restores it in a
`finally` block before the round completes or Packer reboots the VM.

This removes avoidable scheduler and guest power-policy throttling; it does not
make servicing fully parallel. Cumulative updates still spend substantial time
in dependency-ordered component-store operations, decompression, verification,
and small random disk I/O. Do not set `TiWorker`, `TrustedInstaller`, or the
update task to High/Realtime priority: that can starve storage, RPC, QEMU-GA,
and WinRM without accelerating serialized work.

Status: **unverified on a live build** at time of writing. On the next real run,
compare update-round duration and host/guest CPU and disk utilization with the
prior build. Confirm the log contains both `throughput mode enabled` and
`restored power scheme`; record the outcome here even if no speedup is observed.

## Debugging workflow

Before changing HCL, an answer file, or a provisioner:

1. Search this document for the symptom or error code.
2. Find the live VM by name:

    ```sh
    ssh "$SSH_TARGET"
    qm list | grep 'packer-windows-server'
    ```

3. Identify the failure stage before proposing a fix:
    - no partitions: setup rejected input before disk configuration;
    - partitions but no Panther logs: early WinPE failure;
    - `$Windows.~BT/Sources/Panther`: apply or WinPE logs;
    - `Windows/Panther`: specialize or installed-OS logs;
    - negligible disk writes plus an OVMF message: boot-prompt timing.

4. Preserve log evidence and update the failure reference or rejected-approach
   section below. Record the symptom, attempted change, and result.

To confirm driver directories on the actual VirtIO ISO:

```sh
ssh "$SSH_TARGET"
mkdir -p /tmp/vm
mount -o loop /var/lib/vz/template/iso/packer-virtio-win-<version>.iso /tmp/vm
ls /tmp/vm/vioscsi/
umount /tmp/vm
```

## Failure reference

| Symptom                                                   | Cause or diagnostic                                                                                                                                                 | Current handling                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Proxmox rejects `ostype`                                  | A release-derived value was invented                                                                                                                                | Read the Proxmox enum; use `win10` for 2019 and `win11` for 2022/2025                                  |
| APIPA address or unreachable WinRM                        | VM is on the wrong bridge or lacks its DHCP reservation                                                                                                             | Use the NAT build bridge and allocated IP/MAC slot                                                     |
| Packer waits for IP discovery                             | Windows has no QEMU agent during setup                                                                                                                              | Set `winrm_host` to the allocated build IP                                                             |
| OVMF reports no bootable device                           | Boot-from-CD keypress missed on a loaded node                                                                                                                       | Keep the two-second wait and roughly 60-second keypress blanket                                        |
| WinRM HTTP 401 during initial setup                       | Basic auth or unencrypted service access was not applied                                                                                                            | Keep the four separate first-logon commands and exact `cmd.exe /c winrm set ... @{...="true"}` quoting |
| WinRM HTTP 401 just after reboot                          | `winrm quickconfig` in the keepalive task reset or disrupted the service                                                                                            | Keepalive only reapplies the two `winrm set` commands; post-reboot provisioners wait 30 seconds        |
| Cloudbase-Init download fails in the VM                   | Older Windows TLS stack cannot reliably fetch the GitHub asset                                                                                                      | Download on the host and attach the MSI to the answer-files ISO                                        |
| Windows Update COM returns access denied                  | WinRM has a network token                                                                                                                                           | Run update work as a SYSTEM scheduled task                                                             |
| Temp PowerShell script is missing after update reboot     | WinRM reconnects before the filesystem settles                                                                                                                      | Retain `pause_before = "30s"` after reboots                                                            |
| `packer-ps-env-vars-*.ps1` not recognized after WU reboot | `ps_execute` waited only for the script (`{{.Path}}`), then dot-sourced the env-vars file (`{{.Vars}}`) which had not landed yet on the post-reboot WinRM reconnect | `ps_execute` now waits for **both** `{{.Path}}` and `{{.Vars}}` (up to 120s) before dot-sourcing `$_v` |
| Server 2025 disk is invisible in WinPE                    | Wrong VirtIO directory                                                                                                                                              | Use `2k25`, not `2k22`                                                                                 |
| Setup fails before partitioning                           | Invalid answer/setup input, including invalid CompactOS option syntax                                                                                               | Inspect attached answer files; do not use the removed `setupconfig.ini` experiment                     |
| Setup fails near 11 GB written with `0x80071160`          | Compact WOF apply cannot be serviced from WinPE                                                                                                                     | Retain `<Compact>false>`                                                                               |
| Specialize fails with `ERROR_BADDB` / `0x800703f9`        | Intermittent corrupt `COMPONENTS` hive transaction state                                                                                                            | Retain retries; investigate host RAM or storage integrity rather than CompactOS permutations           |
| WU round-two provisioner exits 1 after ~4 min, no artifact | Update Orchestrator auto-restarts the headless VM mid-scan, killing the powershell provisioner; retries all die the same way                                        | `Install.ps1` disables WU auto-update/auto-reboot for the build; `Finalize.ps1` restores it before sysprep |
| Two builds interfere or an orphan controls the slot       | Stale remote Packer/watchdog or fixed VMID state                                                                                                                    | Slot-derived VMIDs, stale process cleanup, orphan VM eviction, and name-based pruning                  |

The intermittent `ERROR_BADDB` failure reproduced with verified install media,
adequate free disk space, and no competing build process. Host RAM or the
storage path remained the leading untested hypothesis. Treat it as a hardware
investigation, not a reason to repeat rejected CompactOS changes.

## Rejected or superseded approaches

- `win2k19`, `win2k22`, and `win2k25` are not Proxmox enum values.
- A fixed `10.0.0.100` address and MAC caused stale-lease and concurrency
  problems; builds now allocate network slots.
- A short OVMF keypress burst missed the boot prompt under node load.
- `winrm quickconfig -force` in the startup keepalive raced Packer after reboot.
- Downloading Cloudbase-Init directly inside the VM failed on older TLS stacks.
- Reusing `2k22` VirtIO drivers for Server 2025 failed disk discovery.
- `setupconfig.ini` with `CompactOS=disable` was invalid; `CompactOS=Never` was
  ignored from the answer-files media.
- WinPE `RunSynchronous` CompactOS commands were ineffective or crashed setup.
- A specialize-pass CompactOS command caused DISM `0x80071160` earlier in setup.
- Removing `<Compact>false>` produced the deterministic phase 71 failure.
- Increasing the disk to 64G did not avoid the compact policy.
- Removing `Windows.old` would reclaim nothing in the observed update flow.
- Letting Windows Update auto-reboot during the build (no suppression) killed the
  round-two provisioner on every attempt; the build now disables WU
  auto-update/auto-reboot for its duration and restores it before sysprep.
