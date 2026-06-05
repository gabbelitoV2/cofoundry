# Changelog

## v1.2.0

### Added

- Adopt the shared `@cofoundry/ui` renderer used by `cf build` so multi-template installs show a live spinner-driven row per template with phase, elapsed time, and download/restore progress.
- Bound parallelism with `--download-concurrency` (default 4, env `COPORT_DOWNLOAD_CONCURRENCY`) and `--restore-concurrency` (default 2, env `COPORT_RESTORE_CONCURRENCY`) so a `coport <all>` run no longer launches 16 simultaneous fetches and 16 simultaneous `qmrestore` processes against a single node. Waiting templates show `queued → download` / `queued → restore` with their elapsed timer paused.
- Add `--verbose` to force the line-oriented stream output (for CI or copy-paste) over the in-place TUI.

### Fixed

- Delete each downloaded `.vma.zst` as soon as its restore completes instead of holding the whole batch on disk until the end. Peak temp usage now scales with in-flight concurrency, not total template count — `coport <all>` peaked at ~38 GB before and stayed under 20 GB after, preventing mid-run exits when disk space was tight.
- Sweep orphaned `${pid}-${ts}` subdirectories under `/var/lib/vz/dump/coport-tmp/` on startup so crashed runs no longer leak gigabytes of temp archives.
- Bring back the per-template progress bar and align the name / phase / VMID columns to a fixed width so 16 parallel rows scan cleanly instead of jittering between widths.
- Throttle per-chunk progress callbacks to ~120 ms and slow the renderer redraw tick to match, cutting the periodic event-loop stalls users saw when many large downloads were active at once.

## v1.1.0

### Added

- Add a `log-update` based multi-template progress view for concurrent downloads and restores.
- Show elapsed time, downloaded size, total size, and transfer speed in the install progress view.
- Bake registry recipe names such as `ubuntu-22.04` into template archives instead of keeping archived `packer-*` names.

### Fixed

- Keep parallel progress output readable when installing multiple templates at once.
- Re-prompt after empty or invalid template selections instead of exiting immediately.
- Preserve piped answers across repeated prompts for scripted usage.
- Close prompt handles after completion so `coport` exits cleanly.
- Handle Ctrl-C by aborting active downloads, terminating active `qmrestore` processes, and removing temporary archives.
- Store downloads in a per-run directory under `/var/lib/vz/dump/coport-tmp` and remove it after completion to avoid accumulated large archives.

## v1.0.0

Initial coport release.

### Added

- Add `coport`, a Proxmox-side installer for Cofoundry VM templates.
- Add template selection from the Cofoundry registry.
- Add SHA-256 verification before restore.
- Add Linux x64 and arm64 release binaries.
- Add `--overwrite` to restore into an existing suggested VMID with `qmrestore -force 1`.

### Fixed

- Use `https://cofoundry.cdn.convoypanel.com/registry.json` as the default registry.
- Use Proxmox-compatible `vzdump-qemu-...vma.zst` temporary filenames so `qmrestore` can detect archive metadata.
- Reduce progress log spam in non-TTY sessions.
- Clarify VMID reassignment prompts so free fallback VMIDs are not presented as conflicts.
