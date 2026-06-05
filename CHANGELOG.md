# Changelog

## v1.2.0

### Added

- Adopt the shared `@cofoundry/ui` renderer used by `cf build` so multi-template installs show a live spinner-driven row per template with phase, elapsed time, and download/restore progress.
- Add `--verbose` to force the line-oriented stream output (for CI or copy-paste) over the in-place TUI.

### Fixed

- Delete each downloaded `.vma.zst` as soon as its restore completes instead of holding the whole batch on disk until the end. Peak temp usage now scales with in-flight concurrency, not total template count — `coport <all>` peaked at ~38 GB before and stayed under 20 GB after, preventing mid-run exits when disk space was tight.
- Sweep orphaned `${pid}-${ts}` subdirectories under `/var/lib/vz/dump/coport-tmp/` on startup so crashed runs no longer leak gigabytes of temp archives.

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
