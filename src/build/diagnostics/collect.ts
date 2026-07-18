import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Env } from '@/env.ts'
import type { RecipeInfo } from '@/config.ts'
import { addSensitiveValues, redactSensitive, shellQuote } from '@/util.ts'
import { captureRemote, remoteTarball } from '@/build/remote.ts'
import {
    diagnosticsRemoteDir,
    diagnosticsRunDirName,
} from '@/build/diagnostics/paths.ts'
import { parseGuestExecOutput } from '@/build/diagnostics/guest-logs.ts'
import { log } from '@/log.ts'

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

// Read the ephemeral per-build secret (the generated Windows admin/WinRM
// password) off the node's vars file and register it for exact-value redaction.
// Exact-string scrubbing is far more reliable than pattern-matching, and Panther
// logs are documented to echo the unattend password verbatim.
const registerEphemeralSecret = async (
    target: string,
    varsFile: string
): Promise<void> => {
    const raw = await captureRemote(
        target,
        `grep -h winrm_password ${shellQuote(varsFile)} 2>/dev/null || true`
    ).catch(() => '')
    const match = raw.match(/winrm_password\s*=\s*"([^"]+)"/)
    if (match?.[1]) addSensitiveValues(match[1])
}

// Extract the gzip tarball streamed back from the node's tmpfs into destDir.
const extractTarball = (buffer: Buffer, destDir: string): void => {
    if (buffer.length === 0) return
    const tmp = mkdtempSync(join(tmpdir(), 'cf-diag-'))
    const tarPath = join(tmp, 'diag.tgz')
    try {
        writeFileSync(tarPath, buffer)
        spawnSync('tar', ['-xzf', tarPath, '-C', destDir], { stdio: 'ignore' })
    } finally {
        rmSync(tmp, { recursive: true, force: true })
    }
}

// Turn each `<name>.json` guest-agent capture into a scrubbed `<name>.log`,
// dropping the JSON wrapper and any empty captures. Returns the log names kept.
const renderGuestLogs = async (logsDir: string): Promise<string[]> => {
    const entries = await readdir(logsDir).catch(() => [] as string[])
    const written: string[] = []
    for (const entry of entries) {
        if (!entry.endsWith('.json')) continue
        const jsonPath = join(logsDir, entry)
        const text = parseGuestExecOutput(
            await readFile(jsonPath, 'utf8').catch(() => '')
        )
        await rm(jsonPath).catch(() => {})
        if (!text) continue
        const name = entry.replace(/\.json$/, '.log')
        await writeFile(join(logsDir, name), text + '\n')
        written.push(name)
    }
    return written
}

// Keep only the most recent K run dirs so repeated local failures don't grow
// ./diagnostics without bound. (CI runners are ephemeral, so this is local-only.)
const pruneLocal = async (baseDir: string, keep: number): Promise<void> => {
    const entries = await readdir(baseDir).catch(() => [] as string[])
    const dirs = (
        await Promise.all(
            entries.map(async name => {
                const path = join(baseDir, name)
                const s = await stat(path).catch(() => null)
                return s?.isDirectory() ? { path, mtime: s.mtimeMs } : null
            })
        )
    ).filter((d): d is { path: string; mtime: number } => d !== null)
    dirs.sort((a, b) => b.mtime - a.mtime)
    for (const d of dirs.slice(keep)) {
        await rm(d.path, { recursive: true, force: true }).catch(() => {})
    }
}

export type CollectDiagnosticsInput = {
    env: Env
    recipe: RecipeInfo
    vmid: number
    isWindows: boolean
    /** Remote path of the injected vars file (source of the ephemeral secret). */
    varsFile: string
    /** In CI the repo is public, so screenshots (unredactable images) are never
     *  pulled/uploaded — only scrubbed text logs. */
    ciMode: boolean
    attempt: number
    error: unknown
    localBaseDir?: string
    keepLocal?: number
    now?: () => Date
}

/**
 * On build failure, pull the recorder's tmpfs contents down to a local
 * `./diagnostics/<recipe>-<arch>-<ts>/`: scrubbed in-guest logs always, and
 * screenshots only for local (non-CI) runs. Returns the local path, or null if
 * nothing could be collected. Best-effort throughout — diagnostics must never
 * turn a build failure into a diagnostics failure. Does NOT remove the remote
 * dir; the caller's teardown does that.
 */
export const collectDiagnostics = async (
    input: CollectDiagnosticsInput
): Promise<string | null> => {
    const now = (input.now ?? (() => new Date()))()
    const baseDir = input.localBaseDir ?? join(process.cwd(), 'diagnostics')
    const runDir = join(baseDir, diagnosticsRunDirName(input.recipe, now))
    const target = input.env.SSH_TARGET

    try {
        await registerEphemeralSecret(target, input.varsFile)

        // Pull the whole tmpfs tree, then render + scrub the guest logs.
        const logsDir = join(runDir, 'logs')
        await mkdir(logsDir, { recursive: true })
        const tarball = await remoteTarball(
            target,
            shellQuote(diagnosticsRemoteDir(input.vmid))
        ).catch(() => Buffer.alloc(0))
        extractTarball(tarball, runDir)
        const logs = await renderGuestLogs(logsDir)

        // Screenshots: local runs only. In CI they'd become world-downloadable
        // artifacts on a public repo and images can't be scrubbed, so drop them.
        const framesDir = join(runDir, 'frames')
        const frames = input.ciMode
            ? 0
            : (await readdir(framesDir).catch(() => [])).length
        if (input.ciMode) {
            await rm(framesDir, { recursive: true, force: true }).catch(
                () => {}
            )
        }

        await writeManifest(runDir, input, now, frames, logs)
        await pruneLocal(baseDir, input.keepLocal ?? 10)

        log.info(
            `diagnostics saved → ${runDir} (${logs.length} log(s)` +
                `${input.ciMode ? '' : `, ${frames} screenshot(s)`})`
        )
        return runDir
    } catch (err) {
        log.warn(`could not collect diagnostics: ${errorMessage(err)}`)
        return null
    }
}

const writeManifest = (
    runDir: string,
    input: CollectDiagnosticsInput,
    now: Date,
    frames: number,
    logs: string[]
): Promise<void> =>
    writeFile(
        join(runDir, 'manifest.json'),
        JSON.stringify(
            {
                recipe: input.recipe.name,
                arch: input.recipe.arch,
                vmid: input.vmid,
                os: input.isWindows ? 'windows' : 'linux',
                attempt: input.attempt,
                collectedAt: now.toISOString(),
                ciMode: input.ciMode,
                error: redactSensitive(errorMessage(input.error)),
                screenshots: input.ciMode
                    ? 'omitted (CI, public repo)'
                    : frames,
                logs,
            },
            null,
            2
        ) + '\n'
    )
