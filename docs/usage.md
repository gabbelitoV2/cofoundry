# Usage

## Build a template

```sh
cf build debian-12
cf build windows-server-2025
cf build debian-12 --skip-artifact-sync
cf build debian-12 --skip-upload
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

## Cloning a template

Cofoundry templates do not contain a baked-in DNS server. When deploying a
clone, set an explicit nameserver that the VM can reach.

This is especially important when the Proxmox node accepts Tailscale MagicDNS.
Tailscale sets the node's resolver to `100.100.100.100`, and Proxmox uses the
node's resolver as the default for a cloud-init VM without its own nameserver.
A clone that is not on the tailnet cannot reach that resolver, so DNS fails.
This affects the deployed clone, not the Cofoundry build or its GitHub Actions
runner.

On Ubuntu, `/etc/resolv.conf` normally points to the systemd-resolved stub at
`127.0.0.53`; use `resolvectl status` to see the actual upstream resolver.

Either give the clone an explicit reachable nameserver, or keep the Proxmox
node from accepting MagicDNS with `tailscale set --accept-dns=false` and set the
node's resolver in **Datacenter → DNS** (for example, `1.1.1.1`).

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

The local scheduler coordinates recipes within one command, while heartbeating
leases on the Proxmox node enforce the same RAM and CPU budgets across independent
`cf build` and `cf verify` processes. If budgets are omitted, node-wide admission
uses 80% of physical RAM and all host CPUs. Explicit budgets remain preferable
when other workloads share the node, and are clamped to those physical safety
ceilings if configured higher.

`--skip-artifact-sync` overrides the default artifact download for that command invocation (env equivalent: `CF_SKIP_ARTIFACT_SYNC=1`).

`--skip-upload` disables the configured artifact and sidecar uploads for that
build invocation. It does not disable the default artifact download to
`CF_OUT_DIR`.

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

- `$PVE_DUMP_DIR/cofoundry-work`, `cofoundry-snapshots`, `cofoundry-cache`,
  `cofoundry-tmp`, and `cofoundry-out` (plus orphaned `cofoundry-work.new.*` links)
- legacy `/tmp/cofoundry/` data, if present
- Uploaded ISOs from Proxmox ISO storage (`packer*.iso` and hash-named ISOs)
- Every `vzdump-qemu-*` archive left in the dump dir, regardless of VMID
- Every `packer-*` build VM and its disks, **including templates** left by
  successful builds (`clean` is a full teardown; `prune` spares templates)
- Disks orphaned in the `CF_STORAGE` pool whose owning VM is already gone
- Interrupted ISO downloads, including PID-suffixed `*.iso.tmp.<pid>` files
- RRD and vzdump telemetry belonging to deleted Cofoundry build/verify VMIDs

Builds and verification runs share a node maintenance lock. They can still run
in parallel with each other, while `clean` takes the exclusive side and waits
for them to finish before tearing down state. A second `clean` also waits, so
cleanup cannot race ISO prefetch, repository upload, Packer, or another cleanup.
Deletion is verified before the command reports success.

### Weekly maintenance

```sh
cf prune           # orphaned VMs + iso-cache files older than 30 days
cf prune --days 7  # stricter cache cutoff
```

Removes:

- VMs and scratch explicitly owned by expired run leases, plus legacy
  non-template `packer-*` VMs older than the cutoff;
- old, unreferenced Packer ISO files and download-cache entries (the persistent
  `packer-virtio-win.iso` cache is preserved and attached media is never pruned);
- vzdump archives and working data older than the selected cutoff;
- orphaned per-build scratch in `cofoundry-tmp` (`build-*`, `repo-*.tar.gz`,
  `sync-*`) and half-swapped `cofoundry-work.new.*` links older than the cutoff;
- unreferenced repository snapshots older than the selected cutoff.

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

- **`check-upstream.yml`** — checks weekly, runs changed recipes in a parallel
  matrix, then publishes once. Publishing and the checksum commit tolerate a
  partial failure: successful recipes are published and get their checksums
  advanced, while a failed recipe keeps its old checksum and is retried next run.
- **`build.yml`** — reusable/manual one-recipe entry point.
- **`build-one.yml`** — parallel-safe build and smoke-test worker.
- **`publish.yml`** — globally serialized registry writer and R2 finalizer.
- **`prune-node.yml`** — lease-aware node maintenance after a workflow finishes.

CI reads the same committed `cofoundry.toml`; it supplies only the secrets and
the `${VAR}` coordinates. See [Setup](setup.md).
