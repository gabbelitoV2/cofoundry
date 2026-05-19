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
- **Windows Server**: the installed OS + VirtIO + Cloudbase-Init takes ~10–12GB. Use `15G` as the minimum that reliably fits.

When adding a new recipe, verify the actual installed size from the vzdump output (`INFO: backup is sparse: X GiB (Y%) total zero data`) and shrink the disk if there is excessive free space.

## Windows Server 2025 requirements

All three of the following are required in `windows-server-2025.pkr.hcl` or the installer bootloops:

1. **`os = "win11"`** — NOT `win10`, NOT `win2k22`. Server 2025 shares the Windows 11 install kernel.
2. **`cpu_type = "host"`** — The 2025 installer probes for SSE4.1/4.2; the default `kvm64` hides it and causes a bootloop.
3. **TPM 2.0 device** — `tpm_config { tpm_storage_pool = ...; tpm_version = "v2.0" }`. The installer enforces TPM 2.0 the same way Windows 11 setup does.

If any one is missing, the installer appears to start then reboots into "press any key to boot from CD" forever. When porting from `windows-server-2022.pkr.hcl`, change `os = "win2k22"` → `os = "win11"`; the `cpu_type` and `tpm_config` block carry over unchanged.

## Preseed SSH key injection

`scripts/inject-placeholders.sh` generates an ephemeral ed25519 keypair and injects the public key into `builds/<recipe>/http/preseed.cfg`. The script replaces both the `__PACKER_SSH_PUBLIC_KEY__` placeholder AND any previously injected key matching the comment `packer-<recipe>-*`, so re-runs without a `git clean` still produce a fresh key. The source `preseed.cfg` should always be committed with the `__PACKER_SSH_PUBLIC_KEY__` placeholder, not a real key.
