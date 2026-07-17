import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'

// ---------------------------------------------------------------------------
// cofoundry.toml — the single source of truth for non-secret deployment config.
//
// The file is committed and reviewable. Secrets (PVE_TOKEN_SECRET, AWS_*) never
// live here — they come from the environment. Sensitive coordinates you'd
// rather keep out of a public repo (PVE_HOST, SSH_TARGET) can be sourced from
// the environment with `${VAR}` interpolation, and a gitignored
// `cofoundry.local.toml` overlay holds per-machine values.
//
// This module resolves the file into the canonical env-var names the rest of
// the codebase already reads (PVE_HOST, CF_STORAGE, …) and *seeds* them into
// `process.env` for any key not already set — so `loadEnv()` and every scattered
// `process.env.X` read pick up file values with zero call-site changes.
//
// Resolution order (highest wins):
//   CLI flag  >  process.env  >  ${VAR}  >  cofoundry.local.toml  >
//   cofoundry.toml  >  built-in default
// ---------------------------------------------------------------------------

export type ConfigSource =
    | 'env' // already present in process.env (wins over the file)
    | 'local' // from cofoundry.local.toml
    | 'toml' // from cofoundry.toml
    | 'derived' // generated in code (upload commands from [upload])
    | 'default' // built-in default used when the file/env omit the field
    | 'unset' // not configured anywhere (schema default may still apply)

export interface ResolvedValue {
    /** Canonical env-var name, e.g. PVE_HOST. */
    key: string
    /** Effective value; undefined when unresolved/unset. */
    value?: string
    source: ConfigSource
    /** Extra context for `cf config`, e.g. the raw `${VAR}` or the layout. */
    detail?: string
}

// TOML path → canonical env var. Order defines display order in `cf config`.
// Secrets are deliberately absent — they are env-only.
const FIELD_MAP: readonly (readonly [path: string, envKey: string])[] = [
    ['node.host', 'PVE_HOST'],
    ['node.node', 'PVE_NODE'],
    ['node.port', 'PVE_PORT'],
    ['node.ssh', 'SSH_TARGET'],
    ['node.token_id', 'PVE_TOKEN_ID'],
    ['node.dump_dir', 'PVE_DUMP_DIR'],
    ['storage.disks', 'CF_STORAGE'],
    ['storage.isos', 'CF_ISO_STORAGE'],
    ['network.bridge', 'CF_BRIDGE'],
    ['network.build_bridge', 'CF_BUILD_BRIDGE'],
    ['network.build_dns', 'CF_BUILD_DNS'],
    ['upload.endpoint', 'R2_ENDPOINT'],
    ['upload.bucket', 'R2_BUCKET'],
    ['upload.prefix', 'R2_PREFIX'],
    ['build.attempts', 'CF_BUILD_ATTEMPTS'],
    ['build.upload_concurrency', 'CF_UPLOAD_CONCURRENCY'],
    ['build.download_concurrency', 'CF_DOWNLOAD_CONCURRENCY'],
    ['local.out_dir', 'CF_OUT_DIR'],
] as const

// Keep these in sync with EnvSchema. They are represented here so `cf config`
// reports the value the command will actually use instead of calling it unset.
// CF_BUILD_ATTEMPTS is intentionally absent: its fallback depends on whether a
// recipe is Windows (3) or not (1).
const DEFAULTS: Readonly<Record<string, string>> = {
    PVE_PORT: '8006',
    PVE_DUMP_DIR: '/var/lib/vz/dump',
    CF_STORAGE: 'local',
    CF_ISO_STORAGE: 'local',
    CF_BRIDGE: 'vmbr0',
    CF_BUILD_BRIDGE: 'vmbr1',
    CF_BUILD_DNS: '1.1.1.1',
    CF_UPLOAD_CONCURRENCY: '8',
    CF_DOWNLOAD_CONCURRENCY: '8',
    CF_OUT_DIR: './dist',
}

export const CONFIG_FILENAME = 'cofoundry.toml'
export const CONFIG_LOCAL_FILENAME = 'cofoundry.local.toml'

type Toml = Record<string, unknown>

const readToml = (path: string): Toml | undefined => {
    let raw: string
    try {
        raw = readFileSync(path, 'utf8')
    } catch {
        return undefined // absent file is fine
    }
    try {
        return parse(raw) as Toml
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`Failed to parse ${path}: ${msg}`)
    }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)

// Deep-merge two TOML trees; `overlay` wins per-key. Used to layer
// cofoundry.local.toml on top of cofoundry.toml.
const deepMerge = (base: Toml, overlay: Toml): Toml => {
    const out: Toml = { ...base }
    for (const [k, v] of Object.entries(overlay)) {
        const prev = out[k]
        out[k] = isObject(prev) && isObject(v) ? deepMerge(prev, v) : v
    }
    return out
}

const getPath = (obj: Toml, dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((acc, part) => {
        return isObject(acc) ? acc[part] : undefined
    }, obj)

const VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g

// Replace `${VAR}` with process.env[VAR]. Returns undefined (unresolved) if any
// referenced variable is unset — the field then behaves as "not configured".
const interpolate = (
    raw: string
): { value?: string; interpolated: boolean } => {
    if (!raw.includes('${')) return { value: raw, interpolated: false }
    let missing = false
    const value = raw.replace(VAR_RE, (_, name: string) => {
        const v = process.env[name]
        if (v === undefined || v === '') {
            missing = true
            return ''
        }
        return v
    })
    return { value: missing ? undefined : value, interpolated: true }
}

interface MergedFile {
    merged: Toml
    /** Per-dotted-path origin so `cf config` can say local vs toml. */
    origin: Map<string, 'local' | 'toml'>
}

const loadMerged = (cwd: string): MergedFile | undefined => {
    const base = readToml(join(cwd, CONFIG_FILENAME))
    const local = readToml(join(cwd, CONFIG_LOCAL_FILENAME))
    if (!base && !local) return undefined

    const merged = deepMerge(base ?? {}, local ?? {})
    const origin = new Map<string, 'local' | 'toml'>()
    for (const [path] of FIELD_MAP) {
        if (local && getPath(local, path) !== undefined)
            origin.set(path, 'local')
        else if (base && getPath(base, path) !== undefined)
            origin.set(path, 'toml')
    }
    return { merged, origin }
}

// ── upload command generation ──────────────────────────────────────────────
// Structured [upload] config replaces the hand-maintained CF_UPLOAD_CMD /
// CF_SIDECAR_UPLOAD_CMD / CF_PUBLIC_URL_TMPL template strings.
//
// The single knob is `key`: the *extensionless* object key (relative to the
// bucket), written with self-describing placeholders the uploader substitutes:
//
//   {{recipe}}   recipe name          e.g. almalinux-10
//   {{arch}}     build architecture   e.g. amd64
//   {{group}}    OS family            e.g. almalinux
//   {{sha256}}   artifact SHA-256     (content address)
//
// We append `.vma.zst` for the artifact and `.json` for the sidecar, and derive
// the public URL from the very same key — so the artifact path, sidecar path,
// and public URL can never drift.
//
// `layout` is sugar for two common, prune-safe `key` presets. `cf prune --r2`
// keeps the newest N per parent prefix, so a prune-safe key gives each template
// its own directory (both presets, and per-recipe layouts like
// `{{recipe}}/{{recipe}}-{{arch}}-{{sha256}}`, satisfy that).

export type UploadLayout = 'grouped' | 'flat'

const LAYOUT_KEY: Record<UploadLayout, string> = {
    grouped: 'templates/{{group}}/{{recipe}}-{{arch}}/{{sha256}}',
    flat: 'templates/{{recipe}}-{{arch}}/{{sha256}}',
}

export const uploadPathTemplate = (layout: UploadLayout): string =>
    LAYOUT_KEY[layout]

interface DerivedUpload {
    uploadCmd?: string
    sidecarCmd?: string
    publicUrl?: string
}

// Resolve the extensionless object-key template from [upload]: explicit `key`
// wins, else the `layout` preset (default "grouped").
const resolveKeyTemplate = (upload: Record<string, unknown>): string => {
    const key = upload.key
    if (key !== undefined && typeof key !== 'string') {
        throw new Error('cofoundry.toml [upload].key must be a string')
    }
    if (key) return key.replace(/\.(vma\.zst|json)$/, '').replace(/^\/+/, '')
    const layout = upload.layout ?? 'grouped'
    if (layout !== 'grouped' && layout !== 'flat') {
        throw new Error(
            `cofoundry.toml [upload].layout must be "grouped" or "flat" (got "${layout}"); or set [upload].key for a custom path`
        )
    }
    return LAYOUT_KEY[layout]
}

const deriveUpload = (merged: Toml): DerivedUpload => {
    const upload = getPath(merged, 'upload')
    if (!isObject(upload)) return {}

    const key = resolveKeyTemplate(upload)

    // Raw command overrides (escape hatch) win over generation. They still
    // support ${VAR} interpolation like any other field.
    const rawUpload = upload.command as string | undefined
    const rawSidecar = upload.sidecar_command as string | undefined

    const resolveMaybe = (value: unknown): string | undefined => {
        if (value === undefined) return undefined
        if (typeof value !== 'string') return String(value)
        return interpolate(value).value
    }

    // Generation is opt-in only when both required coordinates resolve. A
    // committed `bucket = "${R2_BUCKET}"` must not turn every local build into
    // an upload attempt when R2 is intentionally unconfigured.
    const endpoint = resolveMaybe(upload.endpoint)
    const bucket = resolveMaybe(upload.bucket)
    const cpCmd = (ext: string): string =>
        `aws --endpoint-url $R2_ENDPOINT s3 cp {{file}} s3://$R2_BUCKET/${key}.${ext}`

    const publicBase = upload.public_url as string | undefined
    const publicUrl = publicBase
        ? `${publicBase.replace(/\/+$/, '')}/${key}.vma.zst`
        : undefined

    const uploadCmd =
        resolveMaybe(rawUpload) ??
        (endpoint && bucket ? cpCmd('vma.zst') : undefined)
    return {
        uploadCmd,
        sidecarCmd:
            resolveMaybe(rawSidecar) ??
            (endpoint && bucket ? cpCmd('json') : undefined),
        // A URL without an upload command would publish a sidecar pointing at
        // an artifact that was never sent anywhere.
        publicUrl: uploadCmd ? resolveMaybe(publicUrl) : undefined,
    }
}

/**
 * Resolve cofoundry.toml (+ .local overlay) into canonical env-var entries
 * WITHOUT mutating process.env. Pure — used by `cf config` and by
 * applyConfigToEnv(). Returns [] when no config file exists.
 */
export const resolveConfig = (cwd: string = process.cwd()): ResolvedValue[] => {
    const loaded = loadMerged(cwd)
    if (!loaded) return []
    const { merged, origin } = loaded
    const out: ResolvedValue[] = []

    for (const [path, key] of FIELD_MAP) {
        const envVal = process.env[key]
        if (envVal !== undefined && envVal !== '') {
            out.push({ key, value: envVal, source: 'env' })
            continue
        }
        const rawVal = getPath(merged, path)
        if (rawVal === undefined) {
            const defaultValue = DEFAULTS[key]
            out.push({
                key,
                value: defaultValue,
                source: defaultValue === undefined ? 'unset' : 'default',
            })
            continue
        }
        const rawStr = String(rawVal)
        const { value, interpolated } = interpolate(rawStr)
        out.push({
            key,
            value,
            source:
                value === undefined ? 'unset' : (origin.get(path) ?? 'toml'),
            detail: interpolated ? rawStr : undefined,
        })
    }

    // Derived upload commands (source: derived, unless env already provides them).
    const derived = deriveUpload(merged)
    const derivedEntry = (key: string, value?: string): void => {
        const envVal = process.env[key]
        if (envVal !== undefined && envVal !== '')
            out.push({ key, value: envVal, source: 'env' })
        else if (value !== undefined)
            out.push({ key, value, source: 'derived' })
    }
    derivedEntry('CF_UPLOAD_CMD', derived.uploadCmd)
    derivedEntry('CF_SIDECAR_UPLOAD_CMD', derived.sidecarCmd)
    derivedEntry('CF_PUBLIC_URL_TMPL', derived.publicUrl)

    return out
}

/**
 * Resolve the config file and seed process.env for every key that came from the
 * file (i.e. not already set in the environment). Call once at CLI startup,
 * before any loadEnv(). Returns the resolution for introspection (`cf config`).
 */
export const applyConfigToEnv = (
    cwd: string = process.cwd()
): ResolvedValue[] => {
    const resolved = resolveConfig(cwd)
    for (const r of resolved) {
        if (r.value === undefined) continue
        if (r.source === 'env') continue // already present
        if (process.env[r.key] === undefined || process.env[r.key] === '') {
            process.env[r.key] = r.value
        }
    }
    return resolved
}
