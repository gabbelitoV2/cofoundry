# Usage

## Build a template

```sh
cf build debian-12
cf build windows-server-2025
cf build debian-12 --skip-sync-back
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

Builds all recipes sequentially. Continues on failure and prints a pass/fail summary at the end.

```sh
cf build-all
cf build-all --skip-sync-back
```

`--skip-sync-back` overrides the default artifact download for that command invocation. `CF_SKIP_SYNC_BACK=1` still works too.

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
- Build VMs in the 91xx/92xx VMID range left over from interrupted builds
- ISO cache files older than N days (ISOs are re-downloaded automatically on next build)

A cron job on the node handles this automatically — see [Setup §8](setup.md#8-set-up-the-weekly-cleanup-cron).

## CDN upload

Set in `.env` and every build will upload the artifact automatically:

```sh
CF_UPLOAD_CMD='aws s3 cp {{file}} s3://my-bucket/templates/{{name}}.vma.zst'
CF_PUBLIC_URL_TMPL='https://cdn.example.com/templates/{{name}}.vma.zst'
```

`{{file}}` is replaced with the local artifact path, `{{name}}` with the recipe name.

## GitHub Actions

- **`check-upstream.yml`** — runs daily. Checks for upstream ISO changes, commits `upstream-checksums.json`, triggers matrix builds for changed recipes.
- **`build.yml`** — reusable per-recipe workflow; also supports manual `workflow_dispatch`.

Required secrets mirror the `.env` variables — set them in your repo's Settings → Secrets.
