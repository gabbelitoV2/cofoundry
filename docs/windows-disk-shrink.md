# Windows Disk Shrink — Handoff

Build Windows on a **larger** disk (installer/servicing headroom) but export a
**smaller** template. The mechanism is generic and opt-in; only recipes that
declare a final size shrink. Currently enabled on `windows-server-2025` only
(build `64G` → export `32G`).

Supersedes the old `WINDOWS_DISK_SHRINK_PLAN.md` (the plan it described is now
implemented — this records what shipped and the gotchas hit along the way).

## How it works

A recipe opts in with a header comment:

```hcl
# final_disk_size: 32G
```

and sizes its HCL `disk_size` larger (the temporary build disk):

```hcl
disks {
  disk_size = "64G"   # build-time working room
  # ...
}
```

Pipeline:

1. **`src/config.ts`** parses `# final_disk_size:` into `RecipeInfo.finalDiskSize`.
2. **`src/build/packer.ts`** (`buildRemoteEnv`) forwards it to the post-processor
   as `CF_FINAL_DISK_SIZE` (only when set).
3. **Guest side — `builds/_shared/windows/Finalize.ps1`**: shrinks `C:` to
   `final − 1G` (margin for the GPT backup header + alignment), *before* zeroing
   free space and sysprep. Fails closed if the used footprint won't fit. The
   final size reaches the guest via the Finalize provisioner's
   `environment_vars = ["CF_FINAL_DISK_SIZE=${local.final_disk_size}"]`.
4. **Host side — `builds/_shared/post/shrink-disk.sh`** (sourced by
   `vzdump-and-cleanup.sh`, called only when `CF_FINAL_DISK_SIZE` is set):
   truncates the `scsi0` qcow2 with `qemu-img resize --shrink` before `vzdump`.
5. **`vzdump`** exports the now-smaller template as today; `cf verify` smoke-tests
   it before publish.

On a clone's first boot, cloudbase-init's `ExtendVolumesPlugin` grows `C:` back
to fill the (now 32G) disk.

> **Two places hold the size, keep them in sync:** the `# final_disk_size:`
> header (drives the host-side shrink via `cf`) and the `final_disk_size` HCL
> local (drives the guest-side shrink via the provisioner env). The recipe has a
> comment noting this.

## Why a larger build disk for 2025 if the export is the same 32G as before?

The benefit is **build-time headroom**, not a smaller advertised disk. 2025's
servicing/WU passes are tight; building at 64G gives them room, then we ship the
same 32G geometry users had before. (64G does **not** dodge CompactOS — MOSETUP
still compact-applies at 64G, footprint stays ~25–27 GB. The big disk is purely
temporary.)

## Safety properties

- **Opt-in:** no header → no shrink. Linux and the other Windows recipes are
  byte-for-byte unaffected.
- **Fail closed:** any shrink failure (guest or host) fails the build before
  `vzdump`/publish. The first test run proved this — the host shrink failed and
  nothing reached the registry or R2.
- **File-backed qcow2 only:** `shrink-disk.sh` aborts loudly on anything else
  rather than guessing.

## Gotchas hit during bring-up

### Host shrink failed with "Operation not permitted"

**Symptom:** guest shrink succeeded (`C: 67.8 GB → 33.3 GB`), sysprep + template
conversion fine, then:

```
qemu-img resize --shrink .../base-200200-disk-1.qcow2 32G
qemu-img: Could not open '...': Operation not permitted
```

**Root cause:** Packer converts the VM to a **template before** the
post-processor runs, and Proxmox sets the **immutable bit (`chattr +i`)** on
template disks (note the `base-` volid prefix). `qemu-img` opened the file
read-only for the format guard fine, but the resize *write* was blocked.

**Fix:** `shrink-disk.sh` clears the immutable bit before `qemu-img resize` and
restores it after — the same `chattr -i` dance `src/verify.ts` uses on restored
template disks.

### Disk index is not `scsi0`'s "disk-0"

The OS disk resolves via `qm config <vmid> | sed -nE 's/^scsi0: ([^,]+).*/\1/p'`
→ `pvesm path`. On 2025 that landed on `base-<vmid>-disk-1.qcow2` (efidisk/
cloud-init take other indices). Resolving by the `scsi0:` config line (not by
guessing `disk-0`) is what makes this correct.

### Unrelated flakiness can still fail a run

The bring-up run's other two retry attempts failed on the **pre-existing**
Windows WU/WinRM flakiness (a WU pass exited 1; a later attempt hit the 45m
WinRM timeout), not on shrink code. `cf` retries the whole build
(`CF_BUILD_ATTEMPTS`); a green run can still need a healthy node.

## GPT-after-shrink (the main remaining risk)

The host truncates the virtual disk to 32G, discarding the **backup GPT header**
that lived at the old 64G end. The primary GPT (LBA 1) and all partitions stay
within 32G (C: ends at 31 GiB), so Windows boots and rebuilds the backup GPT on
first boot. **`cf verify` (restore + boot + guest-agent) is the gate that proves
this** — watch it on each shrink-enabled build.

## Rolling out to more recipes

To enable on another recipe (e.g. 2019/2022 at `32G` → `15G`):

1. Bump the HCL `disk_size` to the build size.
2. Add `# final_disk_size: <size>` header **and** a `final_disk_size` local.
3. Add `environment_vars = ["CF_FINAL_DISK_SIZE=${local.final_disk_size}"]` to
   that recipe's `Finalize.ps1` provisioner.
4. Dispatch `Build template` and confirm `cf verify` passes before trusting it.

## Files

- `src/config.ts` — parse `final_disk_size`
- `src/build/packer.ts` — forward `CF_FINAL_DISK_SIZE`
- `builds/_shared/windows/Finalize.ps1` — guest-side `C:` shrink
- `builds/_shared/post/shrink-disk.sh` — host-side qcow2 shrink
- `builds/_shared/post/vzdump-and-cleanup.sh` — sources + invokes the shrink
- `builds/windows-server-2025.pkr.hcl` — first enabled recipe
