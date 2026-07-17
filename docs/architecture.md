# Architecture

Cofoundry separates command-line presentation, domain orchestration, remote
infrastructure, and command construction so each layer can be understood and
tested independently.

## Application boundary

`src/cli.ts` is the startup and error boundary. It resolves configuration,
installs the process environment required by child tools, registers commands,
and owns uncaught failures and process exit status.

`src/commands/` contains the command registrations and user-facing handlers.
Handlers call domain modules and return or throw; lower layers do not terminate
the process.

## Domain modules

- `src/build/` owns repository sync, asset prefetch, build-network allocation,
  Packer execution, watchdogs, retries, artifact selection, and artifact sync.
- `src/bootstrap/` separates the interactive setup flow from probe/apply step
  definitions and SSH execution.
- `src/prune/` separates node cleanup from R2 retention planning.
- `src/upload/` separates artifact sources, sidecar loading, key rendering, and
  command execution.
- `src/config-file/` owns TOML layering, interpolation, and derived upload
  configuration.
- `src/build/sftp/` contains cross-platform SFTP connection, progress, and
  transfer concerns behind narrow interfaces.

Small compatibility barrels such as `src/build.ts` preserve convenient imports
without accumulating implementation logic.

## Build pipeline

A build proceeds through four stages:

1. activate a content-addressed repository snapshot on the Proxmox node;
2. prefetch the recipe's ISO and shared installer assets;
3. allocate build resources and run Packer with bounded retries;
4. synchronize the resulting artifact and sidecar back to the caller.

ISO installers receive a serialized NAT-network slot containing an IP, MAC, and
DHCP reservation. Their live VMID is derived from the recipe base VMID and slot
index. Cleanup handlers release secrets, reservations, watchdogs, and transient
VM state on normal completion and supported signals; stale-state reconciliation
handles interrupted remote processes on the next run.

### Repository snapshots and platform support

Repository upload must work from Windows, macOS, and Linux without extra local
executables. Cofoundry intentionally does not use `rsync`: Windows does not
reliably provide it, and npm packages described as rsync wrappers generally
invoke an externally installed `rsync` binary rather than implementing the
protocol. Requiring it would make a nominally JavaScript CLI depend on WSL,
Cygwin, or a separate native install on Windows.

Instead, the maintained [`tar`](https://www.npmjs.com/package/tar) package
creates a deterministic archive in the local Node/Bun process after applying
Cofoundry's repository exclusions. Cofoundry hashes the sorted file paths,
modes, sizes, and contents, uploads the one archive through SFTP, and extracts
it into `$PVE_DUMP_DIR/cofoundry-snapshots/<sha256>`. The stable
`cofoundry-work` path is an atomically switched symlink to that immutable
snapshot. Each Packer build copies it into its own writable directory under
`cofoundry-tmp`, because placeholder injection modifies recipe files.

This design requires neither local `rsync` nor local `tar`. The remote `tar`
command is acceptable because the destination is always the Linux-based
Proxmox node. Large artifact downloads continue to use SFTP directly and may
use parallel connections; they are not repackaged. Repository upload is now one
file, so the obsolete `--upload-concurrency`, `CF_UPLOAD_CONCURRENCY`, and
`build.upload_concurrency` settings were removed.

## Invariants

- `src/build/paths.ts` is the source of truth for remote dump, output, work,
  snapshot, asset-cache, temporary, and ISO-cache paths.
- Packer credentials are passed through `PKR_VAR_*` environment variables, not
  command-line arguments.
- Shared shell quoting and redaction live in `src/util.ts`.
- All application logging goes to stderr; stdout remains available for JSON and
  artifact-oriented output.
- Pure planning and rendering logic should be separated from SSH, filesystem,
  and subprocess effects so it can be tested without a Proxmox node.
- Fatal-signal registration belongs at explicit application or operation
  boundaries, never in module import side effects.

## Verification

For ordinary changes, run:

```sh
bun run prettier --write src/ tests/
bun test
bun run typecheck
```

Changes to build orchestration should also exercise the relevant dry-run or live
path against a disposable build VM. Recipe changes require a full recipe build
because unit tests cannot validate installer media or unattended setup behavior.
