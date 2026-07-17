# Architecture refactor handoff

Status: complete (2026-07-17)

## Goal

Make the `cf` implementation easy to decode by separating CLI presentation,
domain orchestration, remote/process infrastructure, and shell command
construction. Internal APIs may break; user-visible behavior should remain
stable unless a change removes an unsafe or untestable boundary.

## Baseline

- `src/`: 5,200 lines. Six files contain about 55% of the code.
- `bun test`: 70 passing.
- `bun run typecheck`: passing.
- Prettier check: passing (with warnings for two obsolete config options).
- Highest-risk gaps: build/bootstrap/prune/upload/CLI orchestration have little
  or no direct behavioral coverage; `src/build/sftp.ts` has 8.57% line coverage.
- Worktree was clean at the start.

## Target architecture

- `src/cli.ts`: startup and error boundary only.
- `src/commands/`: one module per CLI command; command handlers return or throw
  and never terminate the process themselves.
- `src/build/`: repo sync, prefetch, build execution, watchdog construction,
  artifact sync, pipeline scheduling, and remote lifecycle in separate modules.
- `src/bootstrap/`: interactive flow separated from independently testable
  probe/apply step definitions.
- `src/prune/`: R2 planning/application separated from node cleanup.
- `src/build/sftp/`: connection, directory walking, transfer progress, upload,
  and download separated behind narrow interfaces.
- One source of truth for remote paths.
- Fatal-signal handlers installed explicitly at the application boundary, not
  as an import side effect.

## Work log

### 2026-07-17 — assessment and baseline

- Confirmed that TypeScript is not the primary cause; large mixed-responsibility
  orchestration functions and embedded Bash are the dominant readability cost.
- Identified `buildPhase` (roughly 250 lines) and the inline VM watchdog script
  as the first extraction target.
- Identified domain-level `process.exit`, global `process.env` reads, import-time
  signal handlers, and duplicated remote paths as cross-cutting cleanup targets.
- Live Proxmox testing is authorized. Start with read-only checks; document any
  state-changing validation before running it.

### 2026-07-17 — build decomposition and import boundaries

- Converted `src/build.ts` into a compatibility barrel.
- Split repository sync, asset prefetch, Packer execution, artifact selection,
  remote paths, VM commands, retry policy, recipe inspection, and watchdog
  construction into focused `src/build/` modules.
- Extracted pure artifact-list selection and retry/attempt policy so they can be
  covered without SSH.
- Centralized dump/work/out/tmp paths in `src/build/paths.ts`.
- Removed import-time signal registration from `src/build/remote.ts`; the CLI
  now explicitly installs and disposes remote cleanup handlers.
- Added the root `@/*` TypeScript alias and migrated all internal `src/` imports.
- Intermediate `bun run typecheck`: passing.

### 2026-07-17 — CLI and operational module decomposition

- Reduced `src/cli.ts` from 495 lines to a 49-line application boundary.
- Added focused command registration modules for build, configuration, recipe
  maintenance, node maintenance, and publishing.
- Removed `process.exit()` from bootstrap, config initialization/doctor, and
  upload domain code. Command modules set failure status; the top-level error
  boundary owns uncaught failures.
- Split bootstrap into flow, model, SSH adapter, and auth/package/network/tmpfs
  step catalogs. The former 647-line module is now a one-line barrel; the
  largest bootstrap implementation file is 257 lines.
- Split R2 pruning from node pruning and extracted a pure `planR2Prune()`.
- Fixed node prune to use configured `PVE_DUMP_DIR` paths and prune the current
  `cofoundry-work` directory instead of only the legacy `/tmp/cofoundry` path.
- Replaced the 417-line SFTP module with connection, walk, progress, upload,
  download, and types modules. Removed the untyped `any` reach-through used for
  SFTP `setstat`.
- Intermediate typecheck and the existing SFTP tests pass.

### 2026-07-17 — configuration, uploads, and characterization tests

- Split the 320-line uploader into source adapters, sidecar loading, template
  rendering, runner, and model modules. Upload subprocess defaults are passed
  explicitly instead of mutating `process.env` during a run.
- Split the 332-line configuration resolver into model, TOML layering,
  structured-upload derivation, and public resolver modules. The deliberate
  process-environment installation remains explicit and confined to CLI startup
  because SSH/AWS/Packer child processes must inherit resolved values.
- Added `CF_BUILD_ATTEMPTS`, `CF_SIDECAR_UPLOAD_CMD`, and R2 location fields to
  the typed environment instead of reading them inside build/upload domains.
- R2 prune and publish now receive an explicit location object.
- Added characterization tests for artifact selection, retry behavior, watchdog
  generation, R2 prune plans, SSH target parsing (including bracketed IPv6), and
  bootstrap size parsing.
- Fixed queued SFTP transfer failures so they propagate through `Promise.all`
  instead of being detached from the caller.
- Removed obsolete Prettier import-order options that emitted warnings on every
  formatting run.

## Verification log

- `bun test`: 90 passing across 22 files (baseline: 70 across 12 files).
- `bun run typecheck`: passing.
- `bun run build`: compiled the Linux CLI successfully (360 modules).
- Prettier check: passing without the previous unknown-option warnings.
- `git diff --check`: passing.
- `cf doctor` against the live environment:
    - SSH: passed.
    - PVE API: passed (`pve 9.1.18`).
    - R2: not executed because the local `aws` executable is absent (`ENOENT`).
- Live SFTP listing: passed against the configured remote output directory (30
  entries).
- Live `cf prune --dry-run`: passed and confirmed it targets the configured
  `/var/lib/vz/dump/cofoundry-work` path. No files or VMs were deleted.
- Live `cf upload --remote --dry-run debian-12`: passed; artifact and sidecar
  commands rendered from the refactored adapters/templates without uploading.
- Full live `ubuntu-24.04` build: passed in 8m54s with R2 commands overridden to
  no-ops. This exercised repo SFTP sync, prefetch, netslot/VMID allocation,
  watchdog stable-port exit, Packer provisioning, vzdump, hashing, sidecar
  generation, VM destruction, secret-temp cleanup, and netslot release.
- Post-build node checks confirmed VMID `100300` absent, slot `00` released, and
  the private build temp directory removed. The test sidecar URL was restored
  atomically from the configured public URL template. R2 was not modified.

## Internal API changes

- Internal source imports use `@/*` (`src/*`) instead of relative traversal.
- `runBootstrap` now receives a typed partial environment.
- `runPruneR2` now receives an explicit R2 location and options separately.
- `buildManifestFromR2` now receives an explicit R2 location before output
  arguments.
- `runPipeline` accepts injectable phase dependencies for characterization
  tests.
- The former large modules remain as small barrels where useful, but their
  implementation symbols now live in focused submodules.

## Remaining work

No required refactor work remains. Two optional follow-ups are deliberately out
of scope for this pass:

1. Install the AWS CLI locally and rerun `cf doctor` to cover its R2 probe.
2. Run a Windows build when Windows-specific behavior changes; this refactor did
   not modify Windows recipes, answer files, or provisioner scripts.
