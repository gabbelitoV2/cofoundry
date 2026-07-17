# Agent Notes

## Development

- Prefer arrow functions in `src/` and `tests/`.
- Put shared helpers in `src/util.ts`; do not duplicate helpers such as
  `shellQuote` inside feature modules.
- Route logging through `src/log.ts`. All log levels write to stderr so stdout
  remains safe for machine-readable output.
- Before committing, run `bun run prettier --write src/ tests/`, `bun test`, and
  `bun run typecheck`.

## Recipe changes

- Read `docs/recipes.md` before changing or adding a recipe.
- Before changing a Windows HCL file, answer file, or provisioner, read
  `docs/windows.md`. Record every new Windows experiment there, including failed
  attempts.
- Never infer a Proxmox `ostype` from a release name. Look up the enum in the
  Proxmox `qemu-server` schema first; see `docs/windows.md#proxmox-os-type`.
- Keep exported disks as small as the measured installed image permits. Confirm
  changes from vzdump sparse-data output before increasing a final disk size.
- Debian preseed files must be committed with the
  `__PACKER_SSH_PUBLIC_KEY__` placeholder, never an injected real key.
