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
- **Windows Server 2025**: the Datacenter Desktop Experience WIM is 23 GB uncompressed. Use `32G`. Install.ps1 decompresses the WOF-compressed OS post-boot (~20-30 min). Final installed footprint is ~25-27 GB. **Disk size does NOT control CompactOS** — bumping to 64G to force a full apply was tried and failed (setupact.log still logged a `(compact)` apply at 64G). So leave it at 32G; the compact apply is unavoidable on this ISO and must be handled via the autounattend `<Compact>false>` directive (see CompactOS section) plus `Compact.exe` post-boot.
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

**The `<Compact>false</Compact>` dilemma (Server 2025).** This is a genuine no-win between two MOSETUP failure modes; `<Compact>false>` is the least-bad and is currently in `autounattend.xml`:

- **With `<Compact>false>`:** the apply reaches the specialize pass and can complete (e.g. the 2026-06-05 build). But it *intermittently* corrupts the component-store transaction log (COMPONENTS hive TxR), causing a CSI load failure (`ERROR_BADDB` / `0x800703f9`) in specialize → "The computer restarted unexpectedly." Intermittent (not every run) — the signature of host-level flakiness, not pure config.
- **Without it (default):** MOSETUP does a `(compact)` apply — *regardless of disk size; 64G was tried and still compacted* — which then **deterministically** fails servicing during the apply with `COperationQueue::Sort: Could not find an execution phase for 71` / DISM `0x80071160` ("Windows Server installation has failed"). Observed 3/3.

So `<Compact>false>` (intermittent success) beats removing it (deterministic failure). `Compact.exe /CompactOS:never` in Install.ps1 still runs post-boot as belt-and-suspenders. The remaining intermittent specialize corruption is ridden by `cf`'s build retries; the prime untried suspect for *why* it corrupts is host RAM on the build node (non-ECC-monitored) — see the repo-root handoff doc.

**Important — WinPE RunSynchronous does NOT work:** MOSETUP (Windows Server 2025's setup engine) does not execute `<RunSynchronous>` commands in the `windowsPE` pass before WIM extraction. Any `compact.exe /CompactOS:never` or `reg add` commands there are silently ignored. CompactOS is enabled by policy detection regardless. Similarly, adding `compact.exe /CompactOS:never` to the `specialize` pass (via `Microsoft-Windows-Deployment`) causes a regression — MOSETUP pre-applies it to the offline staging image in WinPE, triggering a DISM `0x80071160` failure.

**Known issue — slow decompression on Windows Server 2025:** The WIM is extracted with WOF compression (CompactOS enabled), so Install.ps1's `Compact.exe /CompactOS:never` must decompress ~14 GB of files. This takes 20-30 minutes. Do not kill the build during this step. See `docs/windows-build-debugging.md` Problem 11 for full context and potential future fix (increasing disk size past MOSETUP's CompactOS threshold).

## Preseed SSH key injection

`scripts/inject-placeholders.sh` generates an ephemeral ed25519 keypair and injects the public key into `builds/<recipe>/http/preseed.cfg`. The script replaces both the `__PACKER_SSH_PUBLIC_KEY__` placeholder AND any previously injected key matching the comment `packer-<recipe>-*`, so re-runs without a `git clean` still produce a fresh key. The source `preseed.cfg` should always be committed with the `__PACKER_SSH_PUBLIC_KEY__` placeholder, not a real key.
