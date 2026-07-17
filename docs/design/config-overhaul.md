# Design proposal — config & setup overhaul

**Status:** proposal (awaiting sign-off)
**Scope:** `cf` config layer + CLI ergonomics, plus aligning `coport`
**Appetite:** full redesign; breaking changes acceptable with a one-shot migration

---

## 1. The problem

Configuration for `cf` has no single source of truth. The same ~14 non-secret
settings are declared and maintained in three places, and the CDN upload layout
in **four**:

| Setting class                                               | `src/env.ts` | `.env.example` | `build.yml`                            | docs                  |
| ----------------------------------------------------------- | ------------ | -------------- | -------------------------------------- | --------------------- |
| Deployment facts (`PVE_HOST`, `CF_STORAGE`, `CF_BRIDGE`, …) | schema       | documented     | `vars.X \|\| secrets.X` × ~15          | tables                |
| Upload command (`CF_UPLOAD_CMD` + sidecar + public URL)     | schema       | big string     | `format('aws … {0} … {3}-{4}/{5}', …)` | tables + footgun note |

Consequences:

1. **Adding one knob = editing three files.** The workflow carries ~25 lines of
   `KEY: ${{ vars.KEY || secrets.KEY }}` boilerplate whose only job is to
   re-declare `env.ts`.
2. **The upload layout is maintained as three independent template strings**
   (`CF_UPLOAD_CMD`, `CF_SIDECAR_UPLOAD_CMD`, `CF_PUBLIC_URL_TMPL`) that must be
   kept byte-consistent by hand. `docs/setup.md` spends ~40 lines warning that
   if they drift, sidecars 404 and `cf prune` silently breaks. A "flat" layout
   is a documented footgun.
3. **Secret vs. non-secret is muddled.** The `vars.X || secrets.X` fallback
   exists only because that boundary was never drawn. Node hostnames, storage
   pools, and bridges are _stable deployment facts_, not secrets and not
   per-invocation — yet they're handled like env vars in both places.
4. **Laptop and CI diverge.** Local reads `.env`; CI reconstructs everything
   from `vars`/`secrets` + inline `format()`. No shared artifact means "works on
   my laptop, broken in CI" is structural.

`coport` is in better shape (it already reads `~/.coport/config.json` + a
`COPORT_REGISTRY` env + CLI arg), but its config convention is unrelated to
`cf`'s, so there's no unified mental model.

---

## 2. The design

### 2.1 Three tiers, each with exactly one home

| Tier                   | Home                                                                            | Examples                                                          |
| ---------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Secrets**            | environment only (`.env` locally, GH Secrets in CI) — never in a committed file | `PVE_TOKEN_SECRET`, `AWS_*`                                       |
| **Deployment facts**   | `cofoundry.toml` (committed) + `cofoundry.local.toml` (gitignored overlay)      | node coords, storage, bridges, upload target                      |
| **Invocation toggles** | CLI flags (already exist)                                                       | `--skip-artifact-sync`, `--keep-vm`, `--ci`, concurrency, out-dir |

The result: **laptop and CI consume the identical committed `cofoundry.toml`.**
The only per-environment inputs are the 4 secrets. CI's env block collapses from
~25 lines to 4.

### 2.2 `cofoundry.toml` (committed)

```toml
# cofoundry.toml — non-secret deployment config for `cf`. Committed & reviewable.
# Secrets (PVE_TOKEN_SECRET, AWS_*) come from the environment, never here.
# Values may interpolate env vars with ${VAR} for anything you'd rather keep
# out of git (see §2.3). An optional gitignored cofoundry.local.toml overrides.

[node]
host     = "pve.example.com"
node     = "pve"
port     = 8006
ssh      = "root@pve.example.com"
token_id = "root@pam!cofoundry"
dump_dir = "/var/lib/vz/dump"

[storage]
disks = "local"          # was CF_STORAGE
isos  = "local"          # was CF_ISO_STORAGE

[network]
bridge       = "vmbr0"   # cloud-image builds (DHCP via guest agent)
build_bridge = "vmbr1"   # ISO-installer + Windows NAT bridge
build_dns    = "1.1.1.1"

[upload]                  # replaces CF_UPLOAD_CMD / _SIDECAR_ / _PUBLIC_URL_TMPL
endpoint   = "https://<acct>.r2.cloudflarestorage.com"
bucket     = "cofoundry-templates"
layout     = "grouped"   # "grouped" | "flat" — both prune-safe by construction
public_url = "https://templates.example.com"   # base; path derived from layout

[build]
attempts = 3             # was CF_BUILD_ATTEMPTS

[local]
out_dir = "./dist"       # was CF_OUT_DIR; only meaningful on a workstation
```

### 2.3 Public-repo safety: layering + `${VAR}` interpolation

This repo is public, so committing `PVE_HOST` / `SSH_TARGET` would leak the
node's address. Two composable mechanisms handle that:

- **`${VAR}` interpolation** in any value: `host = "${PVE_HOST}"` sources the
  fact from the environment/secrets while keeping the _structure_ committed.
- **`cofoundry.local.toml`** (gitignored) — an overlay merged on top of
  `cofoundry.toml` for private or per-machine values.

**Resolution order (highest wins):** explicit CLI flag → process env → matching
`${VAR}` → `cofoundry.local.toml` → `cofoundry.toml` → built-in default.

So a public checkout commits everything non-sensitive, points the address-y
fields at `${PVE_HOST}` etc., and the operator supplies those via `.env` /
GH Secrets exactly as today — but _only those_, not all 14.

### 2.4 Kill the upload templating

`[upload]` is structured; the `aws s3 cp` command is generated in code from
`{endpoint, bucket, layout}`. `layout` is an enum, so both paths are
prune-safe by construction and the public URL is derived from the _same_ layout
— the "three strings must agree" bug class disappears:

| layout    | object path                                        | prune-safe |
| --------- | -------------------------------------------------- | ---------- |
| `grouped` | `templates/{group}/{name}-{arch}/{sha256}.vma.zst` | ✅         |
| `flat`    | `templates/{name}-{arch}/{sha256}.vma.zst`         | ✅         |

Escape hatch for the rare bespoke case: an optional raw
`[upload].command` / `sidecar_command` still accepts the current `{{…}}`
templates. It's no longer the primary interface, just a fallback.

### 2.5 `coport` alignment

`coport` keeps its consumer-side config but adopts the same conventions:

- config at `~/.config/coport/config.toml` (TOML like `cf`; JSON still read for
  back-compat), same `${VAR}` interpolation.
- a `coport config` introspection command (see §3).
  No behavioral change to install logic — this is purely making the two tools
  feel like one family.

---

## 3. CLI ergonomics

| Command         | Purpose                                                                                                        | Replaces / adds                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `cf config`     | Print resolved config with the **source of each value** (file / local / env / default), secrets redacted.      | New. Kills "why is it using the wrong bridge?"               |
| `cf init`       | Scaffold `cofoundry.toml` interactively; `--from-env` generates it from current env vars (the migration path). | Replaces "copy `.env.example`, hand-edit".                   |
| `cf doctor`     | Preflight: SSH reachable, PVE API auth OK, R2 creds valid.                                                     | New; folds the connectivity checks scattered in `bootstrap`. |
| `coport config` | Same introspection for the consumer side.                                                                      | New.                                                         |

**Flag consistency pass.** Artifact sync now has one spelling across surfaces:
`--skip-artifact-sync` / `CF_SKIP_ARTIFACT_SYNC`. `cf build` with no recipe
names builds everything, so the redundant `build-all` alias is gone.

`cf bootstrap` stays as-is (it configures the **node**); `cf init` configures
the **repo**. They're complementary — the docs will say so explicitly.

---

## 4. Before / after — `build.yml`

**Before** — job `env:` block (~25 lines) + per-step `format()` upload strings:

```yaml
env:
    PVE_TOKEN_SECRET: ${{ secrets.PVE_TOKEN_SECRET }}
    AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
    # …
    PVE_HOST: ${{ vars.PVE_HOST || secrets.PVE_HOST }}
    PVE_PORT: ${{ vars.PVE_PORT || secrets.PVE_PORT }}
    # … 11 more `vars.X || secrets.X` lines …
    # and in the build step:
    CF_UPLOAD_CMD: ${{ vars.CF_UPLOAD_CMD || format('aws --endpoint-url {0} s3 cp {1} s3://{2}/templates/{3}-{4}/{5}.vma.zst', secrets.R2_ENDPOINT, '{{file}}', …) }}
    CF_SIDECAR_UPLOAD_CMD: ${{ … another format() … }}
    CF_PUBLIC_URL_TMPL: ${{ vars.CF_PUBLIC_URL_TMPL }}
```

**After** — the committed `cofoundry.toml` carries all of that; only secrets remain:

```yaml
env:
    PVE_TOKEN_SECRET: ${{ secrets.PVE_TOKEN_SECRET }}
    AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
    AWS_DEFAULT_REGION: auto
# build step: just `bun run cf build ${{ inputs.recipe }} --ci --verbose`
```

`docs/setup.md`'s "Set repo secrets and variables" section shrinks from two big
tables (7 secrets + 16 variables) to one short list (4 secrets). The custom
upload-layout subsection (~40 lines) is deleted — it's a two-line `[upload]`
block now.

---

## 5. Migration (one-shot, breaking)

1. Ship `src/config-file.ts` (loads/merges TOML + `.local` + env + `${VAR}`),
   refactor `loadEnv()` to read from it. Keep the `Env` type shape so call sites
   don't churn.
2. **Deprecation shim:** if legacy `PVE_HOST` etc. are set in env but no
   `cofoundry.toml` exists, `cf` errors with:
   `No cofoundry.toml found. Run 'cf init --from-env' to migrate your current
settings.` One command, done.
3. `cf init --from-env` writes `cofoundry.toml` from whatever env/`.env` is
   present, pointing address fields at `${VAR}` where they look sensitive.
4. Update the 2 build workflows (`build.yml`, `check-upstream.yml` inherits).
5. Rewrite `docs/setup.md` §2/§3 and `.env.example` (now secrets-only).
6. Add `cofoundry.local.toml` to `.gitignore`.

Tests: unit-test the resolver's precedence + `${VAR}` interpolation + layout →
path/URL derivation (this replaces the manual "keep three strings in sync"
discipline with an assertion).

---

## 6. Resolved decisions

**Public-repo address handling (§2.3): layered config + `${VAR}` interpolation
— CONFIRMED.** Sensitive coordinates (`PVE_HOST`, `SSH_TARGET`) never land in
the committed file; they interpolate from env via `${VAR}`, with an optional
gitignored `cofoundry.local.toml` overlay for per-machine values. Everything
non-sensitive is committed. Resolution order:
`flag > env > ${VAR} > cofoundry.local.toml > cofoundry.toml > default`.

---

## 7. Rough sequencing

1. `config-file.ts` loader + resolver + tests
2. `[upload]` structured → code-generated commands (delete templating)
3. `cf config` / `cf init` / `cf doctor`
4. Workflow + docs + `.env.example` rewrite
5. `coport` alignment (TOML + `coport config`)
6. Flag-consistency pass

Steps 1–4 deliver ~90% of the felt improvement; 5–6 are polish.

---

## 8. Implementation status (shipped)

All six steps landed. Refinements made during implementation:

- **Upload knob is `key`, not just a `layout` enum.** `[upload].key` is the
  extensionless object key (e.g. `templates/{{group}}/{{recipe}}-{{arch}}/{{sha256}}`);
  `layout = "grouped" | "flat"` are presets for it. The upload command, sidecar
  command, and public URL are all derived from that one key — they cannot drift.
- **Placeholders renamed for clarity.** `{{name}}` → `{{recipe}}` (the sidecar's
  `name` field is `recipe-arch`, so `{{name}}` was ambiguous). `{{name}}` /
  `{{filename}}` remain as back-compat aliases for hand-written `command`
  overrides. Set: `{{recipe}} {{arch}} {{group}} {{sha256}}` (+ `{{file}}`).
- **Standard layout is `grouped`** (`templates/{{group}}/{{recipe}}-{{arch}}/{{sha256}}`),
  chosen to supersede the old ad-hoc `{{name}}/{{filename}}` scheme now that the
  bucket isn't production. `[upload].prefix = "templates/"` scopes `cf publish --r2`.
- **New commands:** `cf config` (resolved values + source, secrets redacted),
  `cf init [--from-env]`, `cf doctor` (SSH / PVE API / R2 preflight).
- **coport aligned:** reads `~/.config/coport/config.toml` (TOML, `${VAR}`) with
  JSON back-compat; `coport --config` introspects (subcommand avoided — it would
  collide with the `[registry]` positional).
- **Flag fix:** the CLI and env now consistently use `--skip-artifact-sync` /
  `CF_SKIP_ARTIFACT_SYNC`. The redundant `build-all` alias was removed; `cf build`
  with no recipe names builds everything.
