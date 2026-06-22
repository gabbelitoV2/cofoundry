# Agent Notes

## Code style

- Prefer arrow functions (`const foo = () => ...`) over `function` declarations across `src/` and `tests/`.
- Shared helpers live in `src/util.ts`. Don't re-declare `shellQuote` (or similar) inside individual modules — import it.
- Logging goes through `src/log.ts`. All levels write to stderr so stdout stays clean for JSON output (`cf check --json`, `cf publish`).
- Run `bun run prettier --write src/ tests/` before committing.
- Run `bun test` and `bun run typecheck` before opening a PR.

## Disk sizing

Keep disks as small as possible. Templates are exported as vzdump `.vma.zst` artifacts — a larger provisioned disk means a larger sparse image even if most of it is empty, and larger transfers downstream.

Guidelines:
- **Linux cloud-image recipes**: match the upstream cloud image's default disk (usually 10G or less). Do not pad.
- **Debian netinstall (preseed)**: the installed base is ~3GB of actual data. Use `5G` — tight but sufficient for the standard task + LVM layout. If a build fails mid-install with a disk full error, bump to `6G`.
- **Windows Server 2019/2022**: the installed OS + VirtIO + Cloudbase-Init takes ~10–12GB. Use `15G` as the minimum that reliably fits.
- **Windows Server 2025**: the Datacenter Desktop Experience WIM is 23 GB uncompressed. Use `64G`. Below ~56G of *evaluated* size (MOSETUP judges the disk ~8 GB below physical, so 32-40G looks too small) Windows Setup auto-enables CompactOS and does a WOF-compressed apply; servicing/specialize over that compressed image intermittently corrupts the component-store transaction log → "computer restarted unexpectedly." At 64G MOSETUP does a plain full apply, which avoids both that corruption and the need for the harmful `<Compact>false>` directive (see CompactOS section). vzdump only stores used blocks, so the larger disk does not bloat the artifact. Final installed footprint is ~25-27 GB.
When adding a new recipe, verify the actual installed size from the vzdump output (`INFO: backup is sparse: X GiB (Y%) total zero data`) and shrink the disk if there is excessive free space.

## Accessing the Proxmox node

To SSH into the Proxmox node directly (e.g. to inspect running VMs, check logs, or mount ISOs):

```
ssh $SSH_TARGET   # SSH_TARGET is set in .env
```

## Before debugging a recurring Windows build failure

**Check `docs/windows-build-debugging.md` first.** That file is the canonical record of every problem and fix that has been tried. Before making any change to a Windows autounattend.xml, HCL, or provisioner script, read that doc to see if the same fix has already been attempted and what the outcome was. After trying anything — whether it works or not — add a new entry to that file with: symptom, what was tried, and the result. This prevents the same back-and-forth from happening across sessions.

To debug on the Proxmox node directly: `ssh ${SSH_TARGET}` (SSH_TARGET is set in `.env`).

To inspect the actual virtio-win ISO contents (e.g. which `2kXX` subdirectories exist):
```
mkdir -p /tmp/vm && mount -o loop /var/lib/vz/template/iso/packer-virtio-win.iso /tmp/vm
ls /tmp/vm/vioscsi/   # check available OS subdirs
umount /tmp/vm
```

## Windows Server 2025 requirements

All three of the following are required in `windows-server-2025.pkr.hcl` or the installer bootloops:

1. **`os = "win11"`** — NOT `win10`, NOT `win2k22`. Server 2025 shares the Windows 11 install kernel.
2. **`cpu_type = "host"`** — The 2025 installer probes for SSE4.1/4.2; the default `kvm64` hides it and causes a bootloop.
3. **TPM 2.0 device** — `tpm_config { tpm_storage_pool = ...; tpm_version = "v2.0" }`. The installer enforces TPM 2.0 the same way Windows 11 setup does.

If any one is missing, the installer appears to start then reboots into "press any key to boot from CD" forever. When porting from `windows-server-2022.pkr.hcl`, change `os = "win2k22"` → `os = "win11"`; the `cpu_type` and `tpm_config` block carry over unchanged.

## CompactOS protection

All Windows `Install.ps1` scripts run `Compact.exe /CompactOS:never` as the first step. This ensures the installed OS is never in CompactOS mode — if Windows setup silently enabled it due to a small disk, this disables it before VirtIO and Cloudbase-Init are installed.

Do NOT use `<Compact>false</Compact>` inside `<OSImage>` in autounattend.xml: that directive corrupts the Windows component store transaction log (COMPONENTS hive TxR state) during WIM extraction on Windows Server 2025, causing a CSI component-store load failure (`ERROR_BADDB` / `0x800703f9`) during specialize, which manifests as "The computer restarted unexpectedly." It is NOT a reliable way to force a full apply, and removing it on a small disk just makes MOSETUP do a *compact* apply (which then fails servicing with DISM `0x80071160`). The correct way to get a non-corrupting full apply is to **size the disk past MOSETUP's CompactOS threshold (`64G`, see disk sizing above)** so Setup chooses a plain apply on its own — no `<Compact>` directive at all. `Compact.exe /CompactOS:never` in Install.ps1 remains as belt-and-suspenders.

**Important — WinPE RunSynchronous does NOT work:** MOSETUP (Windows Server 2025's setup engine) does not execute `<RunSynchronous>` commands in the `windowsPE` pass before WIM extraction. Any `compact.exe /CompactOS:never` or `reg add` commands there are silently ignored. CompactOS is enabled by policy detection regardless. Similarly, adding `compact.exe /CompactOS:never` to the `specialize` pass (via `Microsoft-Windows-Deployment`) causes a regression — MOSETUP pre-applies it to the offline staging image in WinPE, triggering a DISM `0x80071160` failure.

**Known issue — slow decompression on Windows Server 2025:** The WIM is extracted with WOF compression (CompactOS enabled), so Install.ps1's `Compact.exe /CompactOS:never` must decompress ~14 GB of files. This takes 20-30 minutes. Do not kill the build during this step. See `docs/windows-build-debugging.md` Problem 11 for full context and potential future fix (increasing disk size past MOSETUP's CompactOS threshold).

## Preseed SSH key injection

`scripts/inject-placeholders.sh` generates an ephemeral ed25519 keypair and injects the public key into `builds/<recipe>/http/preseed.cfg`. The script replaces both the `__PACKER_SSH_PUBLIC_KEY__` placeholder AND any previously injected key matching the comment `packer-<recipe>-*`, so re-runs without a `git clean` still produce a fresh key. The source `preseed.cfg` should always be committed with the `__PACKER_SSH_PUBLIC_KEY__` placeholder, not a real key.
