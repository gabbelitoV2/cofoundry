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

Cloudbase-Init is deliberately installed after Windows Update. Server 2025
checkpoint cumulative updates can perform a near-full OS redeploy and create
`C:\Windows.old`. Installed software survived the observed redeploy, but the
late install guarantees Cloudbase-Init is present immediately before export.
The observed `Windows.old` directory was empty by finalization, so no cleanup
step is needed.

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
mount -o loop /var/lib/vz/template/iso/packer-virtio-win.iso /tmp/vm
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
