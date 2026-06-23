# Windows Disk Shrink Plan

## Goal

Give Windows installers more temporary disk headroom during Packer builds, then export a smaller final template disk without hardcoding distro-specific behavior into the core build pipeline.

The first implementation should target Windows only. The orchestration should stay metadata-driven so other OS families can opt in later with their own shrink method.

## Current Context

- Windows recipes currently size the build disk directly to the final template disk size.
- Server 2025 is tight at `32G`, but larger disks previously did not avoid CompactOS on this ISO.
- The Windows unattended layout is simple: EFI, MSR, then one extending NTFS `C:` partition. There is no trailing recovery partition to move.
- `Finalize.ps1` already zeroes free space before sysprep.
- `vzdump-and-cleanup.sh` owns the final stopped-VM export path, so host-side shrink belongs there or in a small script called from there.

## Design Principles

- Keep `cf` generic: parse recipe metadata and pass neutral environment variables.
- Keep OS-specific shrink details outside `src/` where possible.
- Make shrink opt-in per recipe.
- Use explicit target sizes, not auto-minimum guessing.
- Fail closed: if shrinking fails, fail the build before publish.
- Preserve current behavior for recipes without shrink metadata.

## Proposed Recipe Metadata

Add header metadata to recipes that want a larger build disk and smaller exported disk:

```hcl
# final_disk_size: 32G
```

The HCL `disk_size` remains the temporary build disk size, for example:

```hcl
disks {
  disk_size = "64G"
  # ...
}
```

`cf build` parses `final_disk_size` and passes it to the post-processor as `CF_FINAL_DISK_SIZE`.

## Windows Implementation

1. Set Windows recipe build disks larger than final size.
2. Add `# final_disk_size: ...` to each Windows recipe.
3. In `Finalize.ps1`, before zeroing free space and sysprep, shrink `C:` to leave a defined amount of free space.
4. After sysprep shutdown and before `vzdump`, shrink the Proxmox disk to `CF_FINAL_DISK_SIZE`.
5. Export with `vzdump` as today.
6. Keep the existing workflow smoke test as the final safety check.

## Windows Guest-Side Shrink

Use PowerShell storage APIs inside the VM:

```powershell
$targetBytes = ... # from a provisioner env var or generated file
$partition = Get-Partition -DriveLetter C
$supported = Get-PartitionSupportedSize -DriveLetter C
$targetBytes = [Math]::Max($targetBytes, $supported.SizeMin)
Resize-Partition -DriveLetter C -Size $targetBytes
```

Important constraints:

- The partition must end before the final virtual disk size.
- Leave enough free space for first boot, pagefile recreation, Cloudbase-Init logs, and Windows servicing.
- Do this before `Zero-FreeSpace "C"` so the new free area is zeroed.
- Re-enable system-managed pagefile after zeroing, as today.

## Host-Side Shrink

After the VM is stopped by sysprep, shrink the Proxmox disk before `vzdump`.

Preferred shape:

1. Resolve the VM disk volume from `qm config "$CF_BUILT_VMID"`.
2. Confirm it is a file-backed qcow2 disk before attempting `qemu-img resize --shrink`.
3. Run `qemu-img resize --shrink <disk-file> "$CF_FINAL_DISK_SIZE"`.
4. Update the VM config size if Proxmox does not infer it automatically.
5. Run `qm rescan --vmid "$CF_BUILT_VMID"` if needed.

The first pass can support the current `dir` storage qcow2 path only. If storage is not file-backed, fail with a clear message rather than guessing.

## Generic Pipeline Changes

- Extend `RecipeInfo` with `finalDiskSize?: string`.
- Parse `# final_disk_size: ...` in `src/config.ts`.
- Add `CF_FINAL_DISK_SIZE` to `buildRemoteEnv` when present.
- Leave `vzdump-and-cleanup.sh` as the single export entry point.
- Add a small helper script, for example `builds/_shared/post/shrink-disk.sh`, called only when `CF_FINAL_DISK_SIZE` is set.

This keeps `src/` aware only of metadata, not Windows internals.

## Initial Windows Targets

Suggested first experiment:

| Recipe | Build disk | Final disk |
| --- | ---: | ---: |
| `windows-server-2019` | `32G` | `15G` |
| `windows-server-2022` | `32G` | `15G` |
| `windows-server-2025` | `64G` | `32G` |

Do not change the final sizes until the exported artifact and smoke test prove the shrink path works.

## Verification

Local checks:

- `bun run prettier --write src/ tests/ builds/`
- `bun test`
- `bun run typecheck`

Workflow checks:

- Dispatch `Build template` for `windows-server-2025` first.
- Confirm logs show guest shrink before zeroing and host shrink before `vzdump`.
- Confirm smoke-test artifact passes.
- Compare `vzdump` sparse output and final `.vma.zst` size against the previous build.

## Risks

- Windows may refuse to shrink `C:` enough if unmovable files remain near the end of the volume.
- Shrinking below the actual partition end corrupts the VM. Host-side shrink must validate partition size first.
- Proxmox storage backends differ; initial host-side shrink should be conservative and only support known qcow2 file-backed disks.
- Server 2025 CompactOS behavior may remain unchanged even with larger temporary disks.

## Open Questions

- Should `CF_FINAL_DISK_SIZE` also be passed into `Finalize.ps1`, or should `Finalize.ps1` use a Windows-specific final size variable generated by `cf`?
- Should we include a fixed free-space reserve, for example `4G`, in addition to the final disk size?
- Should host shrink happen before or after `qm set --name`? It likely does not matter, but keeping it immediately before `vzdump` makes the export path easier to audit.
