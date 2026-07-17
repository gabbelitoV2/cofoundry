# Usage

## Build a template

```sh
cf build debian-12
cf build windows-server-2025
cf build debian-12 --skip-artifact-sync
```

The first run for a recipe downloads the ISO to the node's cache automatically. Subsequent builds skip the download. Output lands in `./dist/`:

```
dist/debian-12.vma.zst       # artifact
dist/debian-12.json          # sidecar (name, sha256, size, url, built_at)
```

## List available recipes

```sh
cf list
```

## Build everything

Omit recipe names to build everything. Builds are stage-pipelined, continue on
failure, and print a pass/fail summary at the end.

```sh
cf build
cf build --skip-artifact-sync
```

Packer builds run one at a time by default. To opt into parallel builds, set a
maximum concurrency and explicit node-wide RAM and CPU budgets. A recipe starts
only when all three limits have capacity:

```sh
cf build --build-concurrency 4 --build-memory-budget 16G --build-cpu-budget 8
```

The persistent equivalents are `build.concurrency`,
`build.memory_budget_mb`, and `build.cpu_budget` in `cofoundry.toml`. Recipe
resource requirements come directly from each `.pkr.hcl` file's `memory` and
`cores` settings.

These budgets coordinate recipes within one `cf build` invocation. Independent
`cf build` processes do not share a scheduler, so use one multi-recipe command
when relying on the resource limits.

`--skip-artifact-sync` overrides the default artifact download for that command invocation (env equivalent: `CF_SKIP_ARTIFACT_SYNC=1`).

## Check for upstream ISO changes

Fetches `Last-Modified`/`ETag` headers from each recipe's upstream ISO URL and compares against `upstream-checksums.json`. Prints which recipes have a new upstream image.

```sh
cf check           # check all recipes
cf check debian-12 # check one recipe
cf check --json    # output changed recipe names as JSON (for CI)
```

Commit `upstream-checksums.json` so CI can track changes across runs.

## Publish a manifest

Aggregates `./dist/*.json` sidecars into `./registry.json` at the repo root, for consumption by [downloader](https://github.com/ConvoyPanel/downloader). In CI, use `cf publish --r2` to source sidecars from R2 instead (artifacts are never synced back to the runner).

```sh
cf publish        # local: dist/*.json → registry.json
cf publish --r2   # CI: lists newest sidecar per template in R2
```

## Cleanup

### After a build (free space on the node)

```sh
cf clean
```

Removes from the Proxmox node:

- `/tmp/cofoundry/` — working directory (lives on tmpfs)
- Uploaded ISOs from Proxmox ISO storage (`packer*.iso` and hash-named ISOs)
- Stale vzdump archives and log files

### Weekly maintenance

```sh
cf prune           # orphaned VMs + iso-cache files older than 30 days
cf prune --days 7  # stricter cache cutoff
```

Removes:

- non-template VMs named `packer-*` left by interrupted builds, regardless of
  their slot-derived VMID;
- ephemeral Packer ISO files and its download cache;
- vzdump archives and working data older than the selected cutoff.

A cron job on the node handles this automatically — see
[Setup: weekly cleanup cron](setup.md#6-weekly-cleanup-cron).

## CDN upload

Configure the `[upload]` block in `cofoundry.toml`; every build then uploads the
artifact and its sidecar automatically:

```toml
[upload]
endpoint   = "${R2_ENDPOINT}"   # from env (contains the account id)
bucket     = "${R2_BUCKET}"
layout     = "grouped"          # templates/{{group}}/{{recipe}}-{{arch}}/{{sha256}}
public_url = "https://cdn.example.com"
prefix     = "templates/"       # what `cf publish --r2` scans
```

The upload command, sidecar command, and public URL are all **generated from the
same key**, so they can never drift. Pick a layout:

| `layout`  | object key                                           |
| --------- | ---------------------------------------------------- |
| `grouped` | `templates/{{group}}/{{recipe}}-{{arch}}/{{sha256}}` |
| `flat`    | `templates/{{recipe}}-{{arch}}/{{sha256}}`           |

Both are prune-safe (each template gets its own directory). For a custom path,
set `key` directly instead of `layout`:

```toml
key = "{{recipe}}/{{recipe}}-{{arch}}-{{sha256}}"
```

Placeholders: `{{recipe}}` (recipe name), `{{arch}}`, `{{group}}` (OS family),
`{{sha256}}`. For a fully hand-written command, set `command` /
`sidecar_command` under `[upload]` (they accept the same placeholders plus
`{{file}}`, the local path). `cf publish --r2` scans `prefix`.

## GitHub Actions

- **`check-upstream.yml`** — runs daily. Checks for upstream ISO changes, commits `upstream-checksums.json`, triggers matrix builds for changed recipes.
- **`build.yml`** — reusable per-recipe workflow; also supports manual `workflow_dispatch`.

CI reads the same committed `cofoundry.toml`; it supplies only the secrets and
the `${VAR}` coordinates. See [Setup](setup.md).
