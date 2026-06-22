# Handoff — Windows Server 2025 build failures (2026-06-22)

Status at handoff: **not yet green.** All the *orchestration* bugs that made the
build fail in many different ways are fixed. One **intermittent** failure
remains (component-store corruption during Windows Setup's specialize pass),
and the evidence now points at the **build node's hardware (RAM)** rather than
config. Config options are effectively exhausted.

## TL;DR

- The 2025 build was failing in several *different* ways on each run. Most were
  real, separable bugs — now fixed (see "Fixed").
- The headline symptom — **"The computer restarted unexpectedly"** in the
  specialize pass — is component-store transaction-log corruption (`ERROR_BADDB`
  / `0x800703f9` from CSI `LoadStore`). It is **intermittent** (the 2026-06-05
  build succeeded with the same config), which is the signature of host-level
  corruption during the heavy WIM decompression.
- We are stuck in a genuine **CompactOS no-win** (see below). The current config
  uses `<Compact>false>` because it is the only setting that can succeed at all.
- **Recommended next step: investigate node RAM** on `us-west` (it is
  non-ECC-monitored). Config has been ruled out as the deterministic cause.

## Fixed (root causes found + resolved)

Commits on `main`, oldest→newest:

1. **`c083f21`** — reverted a bad change (`dad0d68`) that removed `<Compact>false>`;
   removing it deterministically breaks the apply (see dilemma).
2. **`972e53e`** — `cf build` now **retries** packer (3× for Windows, override
   `CF_BUILD_ATTEMPTS`) and win2025 `winrm_timeout` 4h→**45m** so a failed
   attempt bounds at ~45m instead of hanging 4h, making retries practical.
3. **`020a62f`** — stream-mode (`--ci`/`--verbose`) now shows **prefetch/sync
   progress** (was a no-op `setProgress`), throttled to 1/sec.
4. **`9a52bb5`** — `WU.ps1` log reads are now **non-fatal**. A `Get-Content` /
   `Add-Content` race on the progress log threw under `ErrorActionPreference=Stop`
   and failed the whole build (false WU failure → wasted ~1.5h reinstall).
5. **`6d9a404`** — the VM-restart **watchdog feeds boot-from-CD keypresses**
   after restarting a Windows VM (a `qm start` can't replay packer's
   `boot_command`, so the VM hung at OVMF "no bootable device").
6. **`b025015`** — **the big one.** Cancelled/failed runs left **orphaned
   `packer build` processes (and watchdogs) running on the node**; because every
   recipe shares a fixed `build_vmid` (2002), a stale `packer -force` would
   `qm stop`/`destroy` the live build's VM and stale watchdogs would `qm start`
   it — a multi-process melee causing mid-install stops, boot hangs, and likely
   some of the "corruption." Fix: pre-clean `pkill`s stale per-recipe packer
   before building; watchdog self-exits when orphaned and tears down its process
   group on signals.
7. **`5d0b932`** — fixed a self-inflicted bug in #6: the `pkill` pattern matched
   its own shell's argv and SIGKILLed itself (ssh exit 255). Uses the `[p]acker`
   character-class self-exclusion trick.

## Open issue: intermittent specialize corruption

Symptom: **"The computer restarted unexpectedly or encountered an unexpected
error. Windows installation cannot proceed."** during the specialize pass.

Confirmed from the VM's `C:\Windows\Panther\setuperr.log`:
```
CSI  (F) HRESULT_FROM_WIN32(1017) from LoadStore(target = NULL)   # 1017 = ERROR_BADDB
IBS  ValidateSMIPass ... status 0x800703f9                        # = HRESULT of 1017
IBS  ...validating unattend file [C:\WINDOWS\Panther\unattend.xml]; hr = 0x800703f9
SP   WINDEPLOY error code is 0x8007001F
```
i.e. the freshly-applied OS's component store (`COMPONENTS` hive) is corrupt, so
CSI can't load it during specialize.

Ruled out (with evidence):
- **Stale CI code** — `qm config 2002` matched the recipe exactly.
- **Disk full** — 53% used, 15G free.
- **Corrupt install media** — `wimlib-imagex verify` on `install.wim` exits 0.
- **Orphan melee** — reproduced on a confirmed *clean single build* (one
  `build_ip`, one process tree, no competing `qm stop`).
- **ISO drift** — cached Windows ISO unchanged since 2026-01-20 (same one that
  succeeded on 06-05).

Because it is intermittent on a clean build with verified media and current
code, the leading remaining suspect is **host-level corruption during the
~13–23 GB WIM decompression** (the node reports `Multi-bit ECC` in SMBIOS but
EDAC is not loaded, so ECC errors are **unmonitored**).

## The CompactOS no-win (why config is stuck)

On this 2025 ISO, **MOSETUP always does a `(compact)` apply** — confirmed at both
32G and 64G (disk size does NOT escape CompactOS; that was tried and failed).
That leaves two options, both bad:

| autounattend | Apply | Result |
|---|---|---|
| **`<Compact>false>`** (current) | reaches specialize | can succeed; **intermittently** corrupts the component store in specialize |
| no directive (default) | `(compact)` | **deterministic** fail at apply: `COperationQueue::Sort: Could not find an execution phase for 71` / DISM `0x80071160` ("Windows Server installation has failed"), 3/3 |

So `<Compact>false>` (intermittent success) is strictly better than removing it
(deterministic failure). `Install.ps1` runs `Compact.exe /CompactOS:never`
post-boot regardless.

## Recommended next steps (in priority order)

1. **Investigate node RAM / hardware on `us-west`.** Run memtest86+ in a
   maintenance window and/or load EDAC and watch `ce_count`/`ue_count` during a
   build. This is the prime untested suspect for the intermittent corruption.
   If RAM is bad, no config change will fix it.
2. **Per-build VMID instead of the fixed `build_vmid = 2002`.** The IP/MAC slot
   allocator already exists; extending it to VMIDs would remove the shared-state
   hazard *by design* (the orphan pre-clean is a mitigation, not a guarantee,
   and it can't protect a local `bun run` overlapping a CI run).
3. **Consider `aio=native`/`threads` instead of `io_uring`** for the build
   disk if RAM checks out — some kernels have had io_uring data-integrity bugs
   that could corrupt heavy decompression writes. (Unverified hypothesis.)
4. If a green build is needed urgently, **keep dispatching with retries** —
   install *has* succeeded before, so enough attempts can land a clean one. Each
   failed attempt now bounds at ~45m.

## Operational notes / gotchas

- **Do not run a local `cf build` and a CI build of the same recipe at once** —
  they share VMID 2002. The pre-clean `pkill` makes the later one win (killing
  the earlier), but it's still disruptive.
- **Cancelling a GitHub run does NOT kill the node-side packer.** Until the next
  build's pre-clean runs, orphans persist. To clean manually:
  ```
  ssh root@us-west "pkill -9 -f '[p]acker build .*windows-server-2025'; \
    pkill -9 -f 'qm status 2002'; \
    qm stop 2002 --skiplock 1; qm destroy 2002 --purge 1 --destroy-unreferenced-disks 1 --skiplock 1"
  ```
- **Reading a stuck VM's setup logs** (read-only, safe while the VM idles at an
  error dialog):
  ```
  ssh root@us-west
  modprobe nbd max_part=8; qemu-nbd --read-only -c /dev/nbd0 -f qcow2 /var/lib/vz/images/2002/vm-2002-disk-1.qcow2
  mount -o ro,noload /dev/nbd0p3 /mnt   # or the NTFS partition
  # WinPE apply stage: /mnt/$Windows.~BT/Sources/Panther/setup{act,err}.log
  # installed stage:   /mnt/Windows/Panther/setup{act,err}.log
  umount /mnt; qemu-nbd --disconnect /dev/nbd0
  ```
- **Build node:** `us-west` (`.env`: `SSH_TARGET=root@us-west`), 15 GiB RAM,
  `dir` storage (qcow2), packer runs **on the node** via SSH.
- See `AGENTS.md` (Windows Server 2025 sections) and
  `docs/windows-build-debugging.md` for the longer-form record.
