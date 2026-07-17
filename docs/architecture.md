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
- `src/build/sftp/` contains connection, traversal, progress, upload, and
  download concerns behind narrow interfaces.

Small compatibility barrels such as `src/build.ts` preserve convenient imports
without accumulating implementation logic.

## Build pipeline

A build proceeds through four stages:

1. synchronize the repository to the Proxmox node;
2. prefetch the recipe's ISO and shared installer assets;
3. allocate build resources and run Packer with bounded retries;
4. synchronize the resulting artifact and sidecar back to the caller.

ISO installers receive a serialized NAT-network slot containing an IP, MAC, and
DHCP reservation. Their live VMID is derived from the recipe base VMID and slot
index. Cleanup handlers release secrets, reservations, watchdogs, and transient
VM state on normal completion and supported signals; stale-state reconciliation
handles interrupted remote processes on the next run.

## Invariants

- `src/build/paths.ts` is the source of truth for remote dump, output, work,
  temporary, and ISO-cache paths.
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
