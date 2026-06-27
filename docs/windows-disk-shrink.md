# Windows Disk Shrink — Handoff

Build Windows on a **larger** disk (installer/servicing headroom) but export a
**smaller** template. The mechanism is generic and opt-in; only recipes that
declare a final size shrink. Currently enabled on `windows-server-2025` only
(build `64G` → export `32G`).

Supersedes the old `WINDOWS_DISK_SHRINK_PLAN.md` (the plan it described is now
implemented — this records what shipped and the gotchas hit along the way).

> **STATUS (2026-06-26): VALIDATED end-to-end.** On branch
> `windows-disk-shrink-plan`, build `28224709691` cleared specialize and ran the
> **entire** shrink path successfully: guest `C:` shrink → host
> `qemu-img resize --shrink … 32G` ("Image resized.") → `vzdump` →
> **`cf verify` restored the shrunk 32G template, booted it, and the guest agent
> responded (1m48s)**. The GPT-after-shrink risk is cleared — Windows rebuilt the
> backup GPT and came up clean on the truncated disk. The immutable-bit fix
> (`2f5227f`) worked in the wild.
>
> That run's *only* failure was the final **publish git-push**, which is
> **non-fast-forward by design on any non-`main` branch**: the `Sync to latest
> main` step does `git reset --hard origin/main`, then `Commit registry.json`
> pushes a main-descended commit to the checked-out feature branch → rejected.
> Nothing to do with the feature.
>
> Earlier theory that the 64G disk *causes* the specialize crash is **disproven**:
> the A/B control on `main` (`28213641482`, 32G) reproduced the **same ~46-minute
> WinRM timeout** on one attempt, then went **green** on a `cf` retry. The crash
> is the node's **intermittent, size-independent specialize flakiness** — **do not
> revert 2025 to 32G** (cargo-cult). See [A/B verdict](#current-blocker-resolved-the-ab-verdict).
>
> **Remaining to ship:** merge this branch to `main` and dispatch the build on
> `main` (where publish works) to produce the published 32G artifact. The
> build+shrink+verify stages are proven; `cf` retries absorb the intermittent CRU.

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

## Current blocker (RESOLVED): the A/B verdict

**The A/B settled it: 64G is exonerated; the crash is intermittent and
size-independent.** Control run `28213641482` (`main`, 32G, no shrink) was driven
on the same node and inspected live via the Proxmox task log for build VM
`200200`:

```
04:26:16Z qmstart  root@pam!ci   ┐ attempt ran 46m05s, then Packer destroyed it
05:12:21Z qmstop   root@pam!ci   ┘ = the SAME ~46-minute WinRM-timeout signature
05:12:33Z qmstart  root@pam!ci   ┐ next attempt
07:26:49Z qmtemplate root@pam!ci ┘ = converted to template ⟹ BUILD SUCCEEDED (green)
```

A 46-minute attempt ending in a Packer `qmdestroy` is the WinRM-timeout failure —
and it happened **at 32G**. So the specialize crash reproduces without the 64G
disk; `cf`'s retry then landed a clean attempt and the build went green. This is
the *"node/Windows flakiness, 64G exonerated"* branch of the decision tree below.
**Reverting 2025 `disk_size` to 32G is therefore unwarranted** — it would not fix
anything (32G fails the same way) and would forfeit the build-time headroom.

Corrections to the original diagnosis (below), from the live task log:

- **The watchdog framing was based on incomplete data.** `root@pam` (no `!ci`) qm
  activity *does* appear, but it is the orchestration SSH shell's `destroyVmCmd`
  (pre-clean), not `buildVmWatchdog` — the watchdog only ever issues `qm start`,
  never `qm stop`/`destroy`. So "no watchdog restart" still holds, but via a
  different reading than originally stated.
- **The "64G is the only pre-WinRM change ⟹ suspect" correlation is broken.** The
  failure reproduces at 32G, so disk size is not the variable.

**Now validated.** The re-dispatched 64G build `28224709691` cleared specialize
(via `cf` retry) and exercised the full shrink path + `cf verify` successfully
(see STATUS at top). The only failure was the publish push (non-`main` branch).
Next action: merge to `main`, dispatch on `main` to publish the 32G artifact.

---

### Original diagnosis (superseded by the verdict above)

## Current blocker: 2025 builds fail before shrink ever runs

**Symptom.** Every `windows-server-2025` build on this branch fails with Packer
`Timeout waiting for WinRM` (~46m), retried 3/3 by `cf` (`CF_BUILD_ATTEMPTS`).
Runs affected: gh `28190160724`, `28206292061` (3/3), and the diagnostic run
`28212433772` (cancelled after root cause was found). The previously-published
2025 artifact in `dist/` (`built_at 2026-06-22`) predates this feature.

**Confirmed root cause (eyes-on, via live VNC screendumps).** Windows Server
2025 Setup intermittently fails its **specialize / oobeSystem pass** with the
blocking modal:

> *Install Windows — "The computer restarted unexpectedly or encountered an
> unexpected error. Windows installation cannot proceed. To install Windows,
> click 'OK' to restart the computer, and then restart the installation."*

The VM sits at that OK dialog forever, so WinRM never becomes usable and Packer
times out. This is the *"intermittent specialize-pass corruption on this node"*
the recipe comment already warns about.

**What it is NOT (ruled out during the 2026-06-26 investigation):**

- **Not the shrink code.** The build dies at WinRM, long before Finalize / the
  guest `C:` shrink / the host `qemu-img resize` / `cf verify`. The shrink path
  is still completely unexercised.
- **Not the node hardware.** Read-only SSH during/after the failed window:
  load <1, RAM/disk free, **no OOM / KVM fault / panic** in the journal. The VM
  `qmstart`ed cleanly every attempt.
- **Not the watchdog** (`buildVmWatchdog` in `src/build.ts`). `qm status
  --verbose` on the stuck VM showed **continuous qemu uptime, a single pid, and
  only one packer-issued (`root@pam!ci`) `qmstart`** — no `root@pam` watchdog
  restart. The guest soft-reboots inside a continuously-running qemu, which the
  watchdog (it only fires on qemu-level `stopped`) never sees. The watchdog's
  "port 5985 stably up ⟹ Packer connected" heuristic (≈`src/build.ts:90`) *is*
  imperfect — port 5985 flickers up during the black "Installing 42%" specialize
  screen before the crash — but it is not the cause here.

**OPEN QUESTION — is the 64G build disk causal, or innocent?** The only
pre-WinRM change on this branch is `disk_size 32G → 64G`. Failures so far:
**4/4 at 64G vs 1 green at 32G** (the Jun 22 `main` build). But that is `n=1` on
the success side, the 4 failures all ran in the same node window (not
independent), and CRU is documented-intermittent — so the correlation is weak
and there is **no known mechanism** by which disk *size* would cause a specialize
CRU (partition layout is `<Extend>true</Extend>`, WIM apply scales with image
content not capacity, CompactOS still applies at 64G). Leading interpretation:
this is probably the pre-existing intermittent node flakiness and 64G is likely a
bystander — **but unproven.**

### RESUME HERE — controlled A/B to settle causation

Run on the *same* node window, then decide:

1. **Control:** `gh workflow run build.yml -f recipe=windows-server-2025 --ref main`
   (32G, no shrink).
   - If it **also** CRU-fails → it's the node/Windows, **64G exonerated**;
     reverting 2025 to 32G would be cargo-cult. Fix is specialize reliability
     (retries / autounattend), not disk size.
   - If it **passes** while 64G keeps failing across ≥2 independent runs → 64G is
     genuinely implicated; *then* revert 2025 `disk_size` to 32G (keep the
     generic opt-in shrink mechanism in the tree, just unused by 2025) and/or dig
     into the specialize failure.
2. Until the A/B says otherwise, **do not change `disk_size`** — don't "fix"
   something not yet proven broken.

**Live-diagnosis recipe (how the root cause was found — reuse it):** while a
build runs, screenshot the guest console from the node (read-only):
`echo "screendump /tmp/s.ppm" | qm monitor 200200` → `pnmtopng /tmp/s.ppm` →
scp + view. Note: qemu HMP wants `screendump <file> [-f png]`; the positional
`png` form errors. Correlate with the WinRM port:
`timeout 3 bash -c 'echo >/dev/tcp/10.0.0.100/5985'`. The build VM is VMID
`200200`; it's destroyed by Packer on failure, so capture live.

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
