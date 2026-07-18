import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Env } from '@/env.ts'
import type { RecipeInfo } from '@/config.ts'
import { addSensitiveValues, redactSensitive, shellQuote } from '@/util.ts'
import { captureRemote, remoteTarball } from '@/build/remote.ts'
import { log } from '@/log.ts'

// Diagnostics live on a RAM-backed tmpfs (/run), never on VM storage
// (PVE_DUMP_DIR / /var/lib/vz). A runaway recorder therefore cannot fill the
// filesystem that holds guest disks and PVE state — the whole point of the
// "node side is the risky side" hardening. See docs/architecture.md.
export const DIAG_TMPFS_BASE = '/run/cofoundry-diag'

export const diagnosticsRemoteDir = (vmid: number): string =>
    `${DIAG_TMPFS_BASE}/${vmid}`

// A command inside the guest, run via the QEMU guest agent (`qm guest exec`).
// The agent is only up once the OS/tools are running, so these are best-effort:
// early-install / WinPE / never-booted failures capture nothing here and the
// screenshots carry the diagnosis instead.
export type GuestLogSpec = { name: string; argv: string[] }

// Linux recipes: cloud-init + the subiquity autoinstall log, plus a bounded
// journal tail. Everything is byte-capped so a huge log can't blow the guest
// agent's output limit.
export const linuxGuestLogs: GuestLogSpec[] = [
    { name: 'cloud-init', argv: ['/bin/sh', '-c', 'tail -c 200000 /var/log/cloud-init.log 2>/dev/null'] },
    { name: 'cloud-init-output', argv: ['/bin/sh', '-c', 'tail -c 200000 /var/log/cloud-init-output.log 2>/dev/null'] },
    { name: 'subiquity', argv: ['/bin/sh', '-c', 'tail -c 200000 /var/log/installer/subiquity-server-debug.log 2>/dev/null'] },
    { name: 'journal', argv: ['/bin/sh', '-c', 'journalctl -b --no-pager 2>/dev/null | tail -c 200000'] },
]

// Windows recipes: the Panther setup logs (their "logging area", per the recipe
// docs) plus a CBS servicing tail — where the Windows Update / finalize
// failures show up.
export const windowsGuestLogs: GuestLogSpec[] = [
    { name: 'panther-setupact', argv: ['powershell', '-Command', 'Get-Content C:\\Windows\\Panther\\setupact.log -Tail 2000 -ErrorAction SilentlyContinue'] },
    { name: 'panther-setuperr', argv: ['powershell', '-Command', 'Get-Content C:\\Windows\\Panther\\setuperr.log -Tail 2000 -ErrorAction SilentlyContinue'] },
    { name: 'panther-unattendgc', argv: ['powershell', '-Command', 'Get-Content C:\\Windows\\Panther\\UnattendGC\\setupact.log -Tail 2000 -ErrorAction SilentlyContinue'] },
    { name: 'cbs', argv: ['powershell', '-Command', 'Get-Content C:\\Windows\\Logs\\CBS\\CBS.log -Tail 2000 -ErrorAction SilentlyContinue'] },
]

export const guestLogSpecs = (isWindows: boolean): GuestLogSpec[] =>
    isWindows ? windowsGuestLogs : linuxGuestLogs

export type RecorderOptions = {
    intervalSec?: number
    maxFrames?: number
    /** Skip a capture when the tmpfs has less than this free (KiB). */
    minFreeKb?: number
    /** Hard backstop: exit the recorder after this many seconds no matter what. */
    maxLifetimeSec: number
    /** 0 disables in-guest log capture. */
    guestLogIntervalSec?: number
    guestLogs?: GuestLogSpec[]
}

const RECORDER_DEFAULTS = {
    intervalSec: 5,
    maxFrames: 30,
    minFreeKb: 32768, // 32 MiB
    guestLogIntervalSec: 60,
}

/**
 * A background Bash recorder, prepended to the remote build script alongside
 * `buildVmWatchdog`. It screendumps the emulated framebuffer into a tmpfs ring
 * buffer every few seconds — so even though Packer deletes the VM on failure,
 * the last frames survive to show the GRUB menu / installer error / auto-logon
 * that Packer's own log can't. It also periodically snapshots the recipe's
 * in-guest log area via the guest agent.
 *
 * Guarded four ways so it can never outlive its build or fill the node:
 *   - orphan check (parent reparented to init) exits the loop;
 *   - a hard max-lifetime backstop;
 *   - a free-space guard skips captures when the tmpfs is tight;
 *   - a fixed-size ring buffer caps total bytes regardless of build length.
 *
 * Its EXIT/signal traps also tear down the watchdog (`$_WDOG_PID`, when set),
 * because appending this after the watchdog would otherwise replace the
 * watchdog's own traps.
 */
export const buildDiagnosticsRecorder = (
    vmid: number,
    opts: RecorderOptions
): string => {
    const interval = opts.intervalSec ?? RECORDER_DEFAULTS.intervalSec
    const maxFrames = opts.maxFrames ?? RECORDER_DEFAULTS.maxFrames
    const minFreeKb = opts.minFreeKb ?? RECORDER_DEFAULTS.minFreeKb
    const guestInt = opts.guestLogIntervalSec ?? RECORDER_DEFAULTS.guestLogIntervalSec
    const guestLogs = opts.guestLogs ?? []
    const dir = diagnosticsRemoteDir(vmid)

    const guestCmds = guestLogs
        .map(spec => {
            const argv = spec.argv.map(shellQuote).join(' ')
            const out = shellQuote(`${dir}/logs/${spec.name}.json`)
            return `      qm guest exec ${vmid} --timeout 15 -- ${argv} > ${out} 2>/dev/null || true`
        })
        .join('\n')

    return `
(
  _dir=${shellQuote(dir)}
  mkdir -p "$_dir/frames" "$_dir/logs" 2>/dev/null || exit 0
  chmod 700 "$_dir" 2>/dev/null || true
  # Probe once whether this QEMU supports PNG screendumps; otherwise fall back
  # to (uncompressed, ~10x larger) PPM, which every version supports.
  _cap="screendump"
  _ext="ppm"
  if echo "screendump -f png $_dir/.probe" | timeout 10 qm monitor ${vmid} >/dev/null 2>&1 && [ -s "$_dir/.probe" ]; then
    _cap="screendump -f png"; _ext="png"
  fi
  rm -f "$_dir/.probe" 2>/dev/null || true
  _start=$(date +%s) _lastlog=0
  while true; do
    if [ "$(ps -o ppid= -p $BASHPID 2>/dev/null | tr -d ' ')" = "1" ]; then break; fi
    [ $(( $(date +%s) - _start )) -ge ${opts.maxLifetimeSec} ] && { echo "[diag] max lifetime reached — exiting" >&2; break; }
    _avail=$(df -Pk ${shellQuote(DIAG_TMPFS_BASE)} 2>/dev/null | awk 'NR==2{print $4}')
    if [ -n "$_avail" ] && [ "$_avail" -ge ${minFreeKb} ]; then
      _f="$_dir/frames/frame-$(date +%s%N).$_ext"
      echo "$_cap $_f" | timeout 10 qm monitor ${vmid} >/dev/null 2>&1 || true
      [ -s "$_f" ] || rm -f "$_f" 2>/dev/null || true
      ls -1t "$_dir"/frames/frame-* 2>/dev/null | tail -n +$(( ${maxFrames} + 1 )) | xargs -r rm -f 2>/dev/null || true
    fi
${
    guestInt > 0 && guestCmds
        ? `    if [ $(( $(date +%s) - _lastlog )) -ge ${guestInt} ]; then
      _lastlog=$(date +%s)
${guestCmds}
    fi
`
        : ''
}    sleep ${interval}
  done
) &
_DIAG_PID=$!
trap 'kill "$_DIAG_PID" "\${_WDOG_PID:-}" 2>/dev/null || true' EXIT
trap 'kill "$_DIAG_PID" "\${_WDOG_PID:-}" 2>/dev/null || true; kill 0 2>/dev/null || true; exit 143' HUP INT TERM
`
}

/**
 * Reap diagnostics dirs left by a build that was SIGKILLed or lost to power
 * loss (where the recorder's traps never ran). Belt-and-suspenders alongside
 * the per-build cleanup, mirroring how netslot reclaims orphaned slots.
 */
export const sweepStaleDiagnosticsCommand = (maxAgeMin = 360): string =>
    `find ${shellQuote(DIAG_TMPFS_BASE)} -mindepth 1 -maxdepth 1 -type d -mmin +${maxAgeMin} -exec rm -rf {} + 2>/dev/null || true`

// A hard lifetime backstop for the recorder, comfortably above the longest a
// real build runs (Windows update rounds can take ~3h).
export const recorderLifetimeSec = (isWindows: boolean): number =>
    isWindows ? 6 * 3600 : 2 * 3600

const timestampDir = (recipe: RecipeInfo, now: Date): string => {
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    return `${recipe.name}-${recipe.arch}-${stamp}`
}

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

// Read the ephemeral per-build secret (the generated Windows admin/WinRM
// password) straight off the node's vars file and register it for exact-value
// redaction. Exact-string scrubbing is far more reliable than pattern-matching,
// and Panther logs are documented to echo the unattend password verbatim.
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

// `qm guest exec --output-format json` returns { "out-data": "<decoded text>" }
// (Proxmox already base64-decodes the guest agent's payload). Pull that field,
// scrub registered secrets, and drop the JSON wrapper.
const renderGuestLogs = async (logsDir: string): Promise<string[]> => {
    const written: string[] = []
    let entries: string[]
    try {
        entries = await readdir(logsDir)
    } catch {
        return written
    }
    for (const entry of entries) {
        if (!entry.endsWith('.json')) continue
        const path = join(logsDir, entry)
        const raw = await readFile(path, 'utf8').catch(() => '')
        let text = raw
        try {
            const parsed = JSON.parse(raw) as { 'out-data'?: string }
            if (typeof parsed['out-data'] === 'string') text = parsed['out-data']
        } catch {
            // keep raw; some agent errors aren't valid JSON
        }
        text = text.trim()
        await rm(path).catch(() => {})
        if (!text) continue
        const outName = entry.replace(/\.json$/, '.log')
        await writeFile(join(logsDir, outName), redactSensitive(text) + '\n')
        written.push(outName)
    }
    return written
}

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

// Keep only the most recent K run dirs locally so repeated local failures don't
// grow ./diagnostics without bound. (CI runners are ephemeral, so this matters
// only for local runs.)
const pruneLocal = async (baseDir: string, keep: number): Promise<void> => {
    let entries: string[]
    try {
        entries = await readdir(baseDir)
    } catch {
        return
    }
    const dirs = await Promise.all(
        entries.map(async name => {
            const path = join(baseDir, name)
            const s = await stat(path).catch(() => null)
            return s?.isDirectory() ? { path, mtime: s.mtimeMs } : null
        })
    )
    const sorted = dirs
        .filter((d): d is { path: string; mtime: number } => d !== null)
        .sort((a, b) => b.mtime - a.mtime)
    for (const d of sorted.slice(keep)) {
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
 * ./diagnostics/<recipe>-<arch>-<ts>/ directory: scrubbed in-guest logs always,
 * and screenshots only for local (non-CI) runs. Returns the local path, or null
 * if nothing could be collected. Best-effort throughout — diagnostics must never
 * turn a build failure into a diagnostics failure. Does NOT remove the remote
 * dir; the caller's teardown does that.
 */
export const collectDiagnostics = async (
    input: CollectDiagnosticsInput
): Promise<string | null> => {
    const now = (input.now ?? (() => new Date))()
    const baseDir = input.localBaseDir ?? join(process.cwd(), 'diagnostics')
    const runDir = join(baseDir, timestampDir(input.recipe, now))
    const remoteDir = diagnosticsRemoteDir(input.vmid)
    const target = input.env.SSH_TARGET

    try {
        await registerEphemeralSecret(target, input.varsFile)

        const logsDir = join(runDir, 'logs')
        await mkdir(logsDir, { recursive: true })

        // Logs (both local and CI): pull the whole tmpfs tree, then render+scrub.
        const tarball = await remoteTarball(target, shellQuote(remoteDir)).catch(
            () => Buffer.alloc(0)
        )
        extractTarball(tarball, runDir)
        const logNames = await renderGuestLogs(logsDir)

        // Screenshots: local runs only. In CI they'd become world-downloadable
        // artifacts on a public repo and images can't be scrubbed, so drop them.
        let frameCount = 0
        const framesDir = join(runDir, 'frames')
        if (input.ciMode) {
            await rm(framesDir, { recursive: true, force: true }).catch(() => {})
        } else {
            frameCount = (await readdir(framesDir).catch(() => [])).length
        }

        const manifest = {
            recipe: input.recipe.name,
            arch: input.recipe.arch,
            vmid: input.vmid,
            os: input.isWindows ? 'windows' : 'linux',
            attempt: input.attempt,
            collectedAt: now.toISOString(),
            ciMode: input.ciMode,
            error: redactSensitive(errorMessage(input.error)),
            screenshots: input.ciMode ? 'omitted (CI, public repo)' : frameCount,
            logs: logNames,
        }
        await writeFile(
            join(runDir, 'manifest.json'),
            JSON.stringify(manifest, null, 2) + '\n'
        )

        await pruneLocal(baseDir, input.keepLocal ?? 10)

        log.info(
            `diagnostics saved → ${runDir} (${logNames.length} log(s)` +
                `${input.ciMode ? '' : `, ${frameCount} screenshot(s)`})`
        )
        return runDir
    } catch (err) {
        log.warn(`could not collect diagnostics: ${errorMessage(err)}`)
        return null
    }
}
