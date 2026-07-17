import { readdir, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import pRetry from 'p-retry'
import {
    createRenderer,
    title,
    accent,
    dim,
    type TaskHandle,
} from '@cofoundry/ui'
import { log } from './log.ts'
import type { Env } from './env.ts'
import { captureRemote } from './build/remote.ts'
import { buildRemoteOutDir } from './build/packer.ts'
import { shellQuote } from './util.ts'

interface Sidecar {
    name: string
    display: string
    arch: string
    group: string
    sha256: string
    size: number
    suggested_vmid?: number
    url: string
    built_at: string
}

export interface UploadOptions {
    sourceDir?: string
    names?: string[]
    skipSidecar?: boolean
    dryRun?: boolean
    remote?: boolean
}

const renderTemplate = (tmpl: string, vars: Record<string, string>): string => {
    let out = tmpl
    for (const [k, v] of Object.entries(vars)) {
        out = out.split(`{{${k}}}`).join(v)
    }
    return out
}

interface Source {
    listJsons(): Promise<string[]>
    readJson(name: string): Promise<string>
    fileExists(name: string): Promise<boolean>
    /** Absolute path to a file in the source dir (for substituting {{file}}). */
    pathOf(name: string): string
    exec(cmd: string): Promise<void>
    label: string
}

const localSource = (sourceDir: string): Source => ({
    label: sourceDir,
    pathOf: name => join(sourceDir, name),
    listJsons: async () => {
        const entries = await readdir(sourceDir)
        return entries.filter(
            e => e.endsWith('.json') && !e.endsWith('.json.tmp')
        )
    },
    readJson: name => readFile(join(sourceDir, name), 'utf8'),
    fileExists: async name => {
        try {
            await access(join(sourceDir, name))
            return true
        } catch {
            return false
        }
    },
    exec: async cmd => {
        await execa('bash', ['-c', cmd], { stdio: 'inherit' })
    },
})

const AWS_VARS = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_DEFAULT_REGION',
    'AWS_REQUEST_CHECKSUM_CALCULATION',
    'AWS_RESPONSE_CHECKSUM_VALIDATION',
    'R2_ENDPOINT',
    'R2_BUCKET',
] as const

// R2's signature validation rejects the x-amz-checksum-* header that AWS CLI
// ≥ 2.23 sends by default on single-PUT uploads, so small uploads (sidecars)
// fail with SignatureDoesNotMatch. Multipart uploads (large artifacts) are
// unaffected because parts use MD5. Default to `when_required` so cf upload
// works against R2 out of the box; user-provided values still win.
const AWS_DEFAULTS: Record<string, string> = {
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
    AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
}

const buildRemoteEnvPrefix = (): string => {
    const pairs: string[] = []
    for (const k of AWS_VARS) {
        const v = process.env[k] ?? AWS_DEFAULTS[k]
        if (v) pairs.push(`${k}=${shellQuote(v)}`)
    }
    return pairs.length > 0 ? pairs.join(' ') + ' ' : ''
}

const remoteSource = (target: string, sourceDir: string): Source => {
    const envPrefix = buildRemoteEnvPrefix()
    return {
        label: `${target}:${sourceDir}`,
        pathOf: name => `${sourceDir}/${name}`,
        listJsons: async () => {
            const out = await captureRemote(
                target,
                `ls -1 ${shellQuote(sourceDir)} 2>/dev/null | grep -E '\\.json$' | grep -v '\\.json\\.tmp$' || true`
            )
            return out
                .split('\n')
                .map(s => s.trim())
                .filter(Boolean)
        },
        readJson: name =>
            captureRemote(target, `cat ${shellQuote(`${sourceDir}/${name}`)}`),
        fileExists: async name => {
            const out = await captureRemote(
                target,
                `[ -f ${shellQuote(`${sourceDir}/${name}`)} ] && echo 1 || echo 0`
            )
            return out.trim() === '1'
        },
        exec: async cmd => {
            await execa('ssh', [target, `${envPrefix}${cmd}`], {
                stdio: 'inherit',
            })
        },
    }
}

// Retry transient R2/network failures: InvalidPart (R2 sometimes loses parts
// mid-CompleteMultipartUpload), RequestTimeout, ServiceUnavailable, connection
// resets, etc. Three attempts with exponential backoff matches what the build
// pipeline uses for remote wget (see src/build.ts:171).
const execWithRetry = async (
    src: Source,
    cmd: string,
    task: TaskHandle
): Promise<void> => {
    await pRetry(
        async () => {
            await src.exec(cmd)
        },
        {
            retries: 2,
            minTimeout: 2000,
            factor: 2,
            onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
                task.log(
                    `attempt ${attemptNumber} failed (${retriesLeft} left): ${error.message.split('\n')[0]}`
                )
            },
        }
    )
}

const loadSidecars = async (
    src: Source,
    names?: string[]
): Promise<{ sidecar: Sidecar; file: string }[]> => {
    const jsons = await src.listJsons()
    const loaded = await Promise.all(
        jsons.map(async f => {
            try {
                const sidecar = JSON.parse(await src.readJson(f)) as Sidecar
                return { sidecar, file: f }
            } catch (err) {
                log.warn(
                    `skipping ${f}: ${err instanceof Error ? err.message : String(err)}`
                )
                return null
            }
        })
    )
    const found = loaded.filter(
        (x): x is { sidecar: Sidecar; file: string } => x !== null
    )
    if (!names || names.length === 0) return found
    const wanted = new Set(names)
    return found.filter(({ sidecar }) => {
        // sidecar.name is "${recipe}-${arch}" (e.g. "almalinux-10-amd64").
        // Accept matches against the full name or the bare recipe name.
        const recipe = sidecar.name.endsWith(`-${sidecar.arch}`)
            ? sidecar.name.slice(0, -(sidecar.arch.length + 1))
            : sidecar.name
        return wanted.has(sidecar.name) || wanted.has(recipe)
    })
}

export const runUpload = async (
    env: Env,
    opts: UploadOptions
): Promise<void> => {
    if (!env.CF_UPLOAD_CMD) {
        throw new Error('CF_UPLOAD_CMD is not set')
    }
    const sidecarCmd = process.env.CF_SIDECAR_UPLOAD_CMD

    // Apply R2-friendly defaults to the local env so the bash -c subprocess
    // inherits them (remote mode forwards via buildRemoteEnvPrefix).
    for (const [k, v] of Object.entries(AWS_DEFAULTS)) {
        if (!process.env[k]) process.env[k] = v
    }

    const src = opts.remote
        ? remoteSource(env.SSH_TARGET, opts.sourceDir ?? buildRemoteOutDir(env))
        : localSource(opts.sourceDir ?? env.CF_OUT_DIR)

    const items = await loadSidecars(src, opts.names)
    if (items.length === 0) {
        log.warn(`No sidecar .json files found in ${src.label}`)
        return
    }

    const renderer = createRenderer({
        title: title(
            `Uploading ${items.length} artifact${items.length === 1 ? '' : 's'} ${dim('from')} ${accent(src.label)}${opts.dryRun ? dim(' (dry-run)') : ''}`
        ),
        outputLines: 2,
    })

    const succeeded: string[] = []
    const failed: { name: string; error: string }[] = []
    const tasks = items.map(({ sidecar }) => ({
        sidecar,
        task: renderer.task(sidecar.name),
    }))

    for (const { sidecar, task } of tasks) {
        const baseName = sidecar.name
        const artifactFile = `${baseName}.vma.zst`
        const sidecarFile = `${baseName}.json`

        task.setPhase('checking artifact')
        if (!(await src.fileExists(artifactFile))) {
            task.fail(`artifact missing (${src.pathOf(artifactFile)})`)
            failed.push({ name: baseName, error: 'artifact missing' })
            continue
        }

        const recipeName = sidecar.name.endsWith(`-${sidecar.arch}`)
            ? sidecar.name.slice(0, -(sidecar.arch.length + 1))
            : sidecar.name
        const vars = {
            file: src.pathOf(artifactFile),
            recipe: recipeName, // clear name, e.g. "almalinux-10"
            arch: sidecar.arch,
            sha256: sidecar.sha256,
            group: sidecar.group,
            // Back-compat aliases for hand-written command overrides.
            name: recipeName,
            filename: `${baseName}-${sidecar.sha256}.vma.zst`,
        }
        const cmd = renderTemplate(env.CF_UPLOAD_CMD, vars)

        task.setPhase(`uploading artifact ${dim(`(${fmtSize(sidecar.size)})`)}`)
        if (opts.dryRun) {
            task.log(cmd)
        } else {
            try {
                await execWithRetry(src, cmd, task)
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                task.fail(`artifact upload failed: ${msg}`)
                failed.push({ name: baseName, error: msg })
                continue
            }
        }

        if (sidecarCmd && !opts.skipSidecar) {
            const scmd = renderTemplate(sidecarCmd, {
                ...vars,
                file: src.pathOf(sidecarFile),
                filename: `${baseName}-${sidecar.sha256}.json`,
            })
            task.setPhase('uploading sidecar')
            if (opts.dryRun) {
                task.log(scmd)
            } else {
                try {
                    await execWithRetry(src, scmd, task)
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    task.fail(`sidecar upload failed: ${msg}`)
                    failed.push({ name: baseName, error: msg })
                    continue
                }
            }
        }

        task.succeed(opts.dryRun ? 'planned' : 'uploaded')
        succeeded.push(baseName)
    }

    renderer.finish()

    log.blank()
    if (failed.length === 0) {
        log.ok(`Uploaded ${succeeded.length}/${items.length}.`)
    } else {
        log.err(
            `${failed.length} failed: ${failed.map(f => f.name).join(', ')}`
        )
        process.exit(1)
    }
}

const fmtSize = (n: number): string => {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}GB`
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}MB`
    return `${(n / 1e3).toFixed(0)}KB`
}
