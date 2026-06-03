# Changelog

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
