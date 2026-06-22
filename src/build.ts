import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pRetry from 'p-retry'
import type { Env } from './env.ts'
import type { RecipeInfo } from './config.ts'
import { shellQuote } from './util.ts'
import {
    captureRemote,
    registerCleanup,
    remoteStreaming,
    remoteWgetCapture,
} from './build/remote.ts'
import {
    sftpUpload,
    sftpDownload,
    type OnProgress,
    type OnPhase,
} from './build/sftp.ts'
import {
    buildPackerVars,
    buildRemoteEnv,
    buildRemoteOutDir,
    buildRemoteTmpDir,
    buildRemoteWorkDir,
    selectBridge,
} from './build/packer.ts'
import { allocateBuildSlot, type BuildSlot } from './build/netslot.ts'

export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))

const fileExists = (path: string): Promise<boolean> => Bun.file(path).exists()

/**
 * Returns a shell fragment that starts a background watchdog alongside Packer.
 *
 * Problem: installers occasionally issue a hard shutdown instead of a reboot
 * mid-install (Windows PE phase, Linux post-copy reboot, etc.), leaving Packer
 * hanging on "Waiting for SSH/WinRM to become available" indefinitely.
 *
 * The watchdog polls `qm status` every 10 s.  If the VM stays in the stopped
 * state for more than 20 s (i.e. it is not just briefly cycling through a
 * normal communicator-triggered restart) it calls `qm start` — up to 5 times.
 *
 * Crucially, it **exits on its own** the moment the communicator port becomes
 * reachable on the build IP.  At that point Packer's provisioners are in
 * control; any subsequent intentional shutdown (e.g. Windows sysprep) must not
 * be restarted.
 *
 * A shell EXIT trap ensures the watchdog subprocess is also killed if Packer
 * exits for any other reason (success, failure, or signal).
 *
 * @param communicatorPort  22 for SSH (Linux), 5985 for WinRM (Windows)
 */
const buildVmWatchdog = (
    vmid: number,
    buildIp: string,
    communicatorPort: number
): string => `
(
  _n=0 _max=5 _up=0 _need=3
  while true; do
    sleep 10
    if timeout 3 bash -c "echo >/dev/tcp/${buildIp}/${communicatorPort}" 2>/dev/null; then
      # Require the communicator port to stay up across several checks before
      # standing down. Windows Setup opens WinRM briefly during OOBE then may
      # reboot/power off for a later phase; exiting on the first hit leaves that
      # shutdown unhandled and Packer waits out its full timeout ("no route to
      # host"). Once the port is *stably* up Packer has connected — safe to exit.
      _up=$((_up + 1))
      if [ "$_up" -ge "$_need" ]; then
        echo "[watchdog] port ${communicatorPort} up on ${buildIp} (stable) — exiting"; exit 0
      fi
      continue
    fi
    _up=0
    _s=$(qm status ${vmid} 2>/dev/null | awk 'NR==1{print $2}') || continue
    [ "$_s" = "stopped" ] || continue
    sleep 20
    _s=$(qm status ${vmid} 2>/dev/null | awk 'NR==1{print $2}') || continue
    [ "$_s" = "stopped" ] || continue
    # A template also reports "stopped". Never qm start it — that fails with
    # "you can't start a vm if it's a template". A template at this point means
    # packer already finished and converted the VM, so there's nothing to
    # restart: exit cleanly instead of burning restart attempts on an error.
    if qm config ${vmid} 2>/dev/null | grep -q '^template:'; then
      echo "[watchdog] VM ${vmid} is now a template — exiting"; exit 0
    fi
    _n=$((_n + 1))
    if [ "$_n" -gt "$_max" ]; then
      echo "[watchdog] VM ${vmid}: restart limit reached, giving up" >&2; exit 1
    fi
    echo "[watchdog] VM ${vmid} stopped unexpectedly (attempt $_n/$_max) — restarting"
    qm start ${vmid} 2>&1 || true
  done
) &
_WDOG_PID=$!
trap 'kill "$_WDOG_PID" 2>/dev/null || true' EXIT INT TERM
`

export type SyncRepoOptions = {
    concurrency?: number
    onProgress?: OnProgress
    onPhase?: OnPhase
}

export const syncRepoToRemote = async (
    env: Env,
    opts: SyncRepoOptions = {}
): Promise<void> => {
    const remoteWorkDir = buildRemoteWorkDir(env)
    await captureRemote(
        env.SSH_TARGET,
        `mkdir -p ${shellQuote(remoteWorkDir)} ${shellQuote(buildRemoteOutDir(env))} ${shellQuote(buildRemoteTmpDir(env))}`
    )
    await sftpUpload(env.SSH_TARGET, REPO_ROOT, remoteWorkDir, {
        excludes: ['.git', 'node_modules', 'out', 'dist'],
        delete: true,
        concurrency: opts.concurrency ?? env.CF_UPLOAD_CONCURRENCY,
        onProgress: opts.onProgress,
        onPhase: opts.onPhase,
    })
    // Files synced from Windows lose the Unix executable bit, so packer's
    // shell-local post-processors fail with "Permission denied" (exit 126).
    // Restore +x on shell scripts after every upload.
    await captureRemote(
        env.SSH_TARGET,
        `find ${shellQuote(remoteWorkDir)} -name '*.sh' -exec chmod +x {} +`
    )
}

export type SyncArtifactsOptions = {
    concurrency?: number
    onProgress?: OnProgress
}

// Pulls everything in the remote out-dir back to local. Used for batched pulls.
export const syncArtifactsBack = async (
    env: Env,
    opts: SyncArtifactsOptions = {}
): Promise<void> => {
    await sftpDownload(env.SSH_TARGET, buildRemoteOutDir(env), env.CF_OUT_DIR, {
        concurrency: opts.concurrency ?? env.CF_DOWNLOAD_CONCURRENCY,
        onProgress: opts.onProgress,
    })
}

// ── Phase 1: prefetch ─────────────────────────────────────────────────────────

export type PrefetchProgress = (slot: string, line: string) => void

const remoteFileExists = async (env: Env, path: string): Promise<boolean> => {
    const out = await captureRemote(
        env.SSH_TARGET,
        `[ -f ${shellQuote(path)} ] && echo 1 || echo 0`
    )
    return out.trim() === '1'
}

export const prefetchPhase = async (
    env: Env,
    recipe: RecipeInfo,
    onLine?: PrefetchProgress
): Promise<void> => {
    const remoteWorkDir = buildRemoteWorkDir(env)

    if (recipe.isoUrl && recipe.isoTargetPath) {
        await captureRemote(
            env.SSH_TARGET,
            `mkdir -p ${shellQuote(recipe.isoTargetPath.replace(/\/[^/]+$/, ''))}`
        )
        if (!(await remoteFileExists(env, recipe.isoTargetPath))) {
            const tmpPath = recipe.isoTargetPath + '.tmp'
            const wgetCmd = `wget -q --show-progress --progress=bar:force:noscroll -O ${shellQuote(tmpPath)} ${shellQuote(recipe.isoUrl)} && mv ${shellQuote(tmpPath)} ${shellQuote(recipe.isoTargetPath)}`
            await remoteWgetCapture(
                env.SSH_TARGET,
                wgetCmd,
                line => onLine?.('iso', line),
                { url: recipe.isoUrl, what: 'iso fetch' }
            )
        }
    }

    if (recipe.name.startsWith('windows-')) {
        const msiDest = `${remoteWorkDir}/builds/_shared/CloudbaseInitSetup_x64.msi`
        if (!(await remoteFileExists(env, msiDest))) {
            // GitHub API can flake; retry the URL fetch + download.
            const curlAndWget = `url=$(curl -s https://api.github.com/repos/cloudbase/cloudbase-init/releases/latest | python3 -c "import sys,json; r=json.load(sys.stdin); print(next(a['browser_download_url'] for a in r['assets'] if 'x64' in a['name'] and a['name'].endswith('.msi')))") && wget -q --show-progress --progress=bar:force:noscroll -O ${shellQuote(msiDest)} "$url"`
            await pRetry(
                () =>
                    remoteWgetCapture(
                        env.SSH_TARGET,
                        curlAndWget,
                        line => onLine?.('msi', line),
                        { what: 'cloudbase-init msi fetch' }
                    ),
                { retries: 3, minTimeout: 1000, factor: 2 }
            )
        }

        const virtioIsoDest = '/var/lib/vz/template/iso/packer-virtio-win.iso'
        const virtioIsoUrl =
            'https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso'
        if (!(await remoteFileExists(env, virtioIsoDest))) {
            const wgetCmd = `wget -q --show-progress --progress=bar:force:noscroll -O ${shellQuote(virtioIsoDest)} ${shellQuote(virtioIsoUrl)}`
            await remoteWgetCapture(
                env.SSH_TARGET,
                wgetCmd,
                line => onLine?.('virtio', line),
                { url: virtioIsoUrl, what: 'virtio iso fetch' }
            )
        }
    }
}

// ── Phase 2: packer build ────────────────────────────────────────────────────

export type BuildPhaseOptions = { keepVm?: boolean }

export type BuildPhaseResult = {
    /** Remote epoch (seconds) captured before packer ran. Used by syncPhase
     *  to filter out stale artifacts left by prior runs. */
    startedAt: number
}

export const buildPhase = async (
    env: Env,
    recipe: RecipeInfo,
    options: BuildPhaseOptions = {},
    onLine?: (line: string) => void
): Promise<BuildPhaseResult> => {
    const remoteWorkDir = buildRemoteWorkDir(env)
    const remoteOutDir = buildRemoteOutDir(env)
    const remoteTmpDir = buildRemoteTmpDir(env)

    // Pre-clean prior artifacts for this recipe so a partial/aborted build
    // can't leave stale `.vma.zst` or `.json` that syncPhase then pulls down.
    // Also capture the remote build-start epoch for the mtime gate below.
    const stalePrefix = `${remoteOutDir}/${recipe.name}-${recipe.arch}`
    const startedAtRaw = await captureRemote(
        env.SSH_TARGET,
        `rm -f ${shellQuote(stalePrefix + '.vma.zst')} ${shellQuote(stalePrefix + '.json')} ${shellQuote(stalePrefix + '.json.tmp')} && date +%s`
    )
    const startedAt = Number.parseInt(startedAtRaw.trim(), 10)
    if (!Number.isFinite(startedAt)) {
        throw new Error(`could not parse remote epoch: ${startedAtRaw}`)
    }
    const hasPreseed = await fileExists(
        `${REPO_ROOT}builds/${recipe.name}/http/preseed.cfg`
    )
    const hasAutoinstall = await fileExists(
        `${REPO_ROOT}builds/${recipe.name}/http/user-data`
    )
    const hasKickstart = await fileExists(
        `${REPO_ROOT}builds/${recipe.name}/http/ks.cfg`
    )
    const isWindows = recipe.name.startsWith('windows-')
    // Any build that can't rely on the qemu-guest-agent for IP discovery runs
    // on the NAT bridge with a per-build dnsmasq reservation: ISO installers
    // (need static network up-front) and Windows (no agent during install).
    const usesBuildBridge =
        hasPreseed || hasAutoinstall || hasKickstart || isWindows
    const buildBridge = selectBridge(
        env,
        recipe.name,
        hasPreseed,
        hasAutoinstall,
        hasKickstart
    )

    let slot: BuildSlot | null = null
    if (usesBuildBridge) {
        slot = await allocateBuildSlot(env)
    }

    if (recipe.buildVmid) {
        await captureRemote(
            env.SSH_TARGET,
            `qm stop ${recipe.buildVmid} --skiplock 1 >/dev/null 2>&1 || true; ` +
                `qm unlock ${recipe.buildVmid} >/dev/null 2>&1 || true; ` +
                `qm destroy ${recipe.buildVmid} --purge 1 --destroy-unreferenced-disks 1 --skiplock 1 >/dev/null 2>&1 || true`
        )
    }

    try {
        const injectEnv = [
            `RUNNER_TEMP=${shellQuote(remoteTmpDir)}`,
            `CF_BUILD_IP=${shellQuote(slot?.ip ?? '')}`,
            `CF_BUILD_GW=${shellQuote(slot?.gw ?? '')}`,
            `CF_BUILD_DNS=${shellQuote(env.CF_BUILD_DNS)}`,
        ].join(' ')
        const varsFile = (
            await captureRemote(
                env.SSH_TARGET,
                `cd ${remoteWorkDir} && ${injectEnv} bash scripts/inject-placeholders.sh ${recipe.name}`
            )
        ).trim()

        const recipeHcl = `${remoteWorkDir}/builds/${recipe.name}.pkr.hcl`

        await remoteStreaming(
            env.SSH_TARGET,
            `packer init ${recipeHcl}`,
            onLine
        )

        const packerArgs = [
            'packer',
            'build',
            '-force',
            ...(options.keepVm ? ['-on-error=abort'] : []),
            '-var-file',
            varsFile,
            ...buildPackerVars(
                env,
                recipe,
                buildBridge,
                slot ? { ip: slot.ip, gw: slot.gw, mac: slot.mac } : null
            ),
            recipeHcl,
        ]
        const remoteEnv = buildRemoteEnv(
            env,
            remoteOutDir,
            remoteTmpDir,
            recipe.arch,
            recipe.group ?? ''
        )

        const unregisterVmCleanup =
            recipe.buildVmid && !options.keepVm
                ? registerCleanup(() => {
                      process.stderr.write(
                          `\ncancelled — destroying build VM ${recipe.buildVmid}\n`
                      )
                      const destroyCmd =
                          `qm stop ${recipe.buildVmid} --skiplock 1 >/dev/null 2>&1 || true; ` +
                          `qm unlock ${recipe.buildVmid} >/dev/null 2>&1 || true; ` +
                          `qm destroy ${recipe.buildVmid} --purge 1 --destroy-unreferenced-disks 1 --skiplock 1 >/dev/null 2>&1 || true`
                      spawnSync('ssh', [env.SSH_TARGET, destroyCmd], {
                          stdio: 'inherit',
                      })
                  })
                : undefined

        // Prepend a watchdog that restarts the VM if it shuts down before the
        // communicator comes up.  Installers (Windows PE and some Linux distros)
        // occasionally issue a hard shutdown instead of a reboot mid-install,
        // leaving Packer hanging on "Waiting for SSH/WinRM to become available".
        // The watchdog exits automatically once the communicator port is
        // reachable, so it never interferes with later intentional shutdowns
        // (e.g. Windows sysprep at the end of Finalize.ps1).
        const communicatorPort = isWindows ? 5985 : 22
        const watchdog =
            recipe.buildVmid && slot
                ? buildVmWatchdog(recipe.buildVmid, slot.ip, communicatorPort)
                : ''
        // Windows builds intermittently fail mid-install (component-store
        // corruption in the specialize pass) on busy nodes. Retry the whole
        // packer build — `-force` recreates the VM from scratch each attempt,
        // so a retry is a clean install, not a resume. Override with
        // CF_BUILD_ATTEMPTS; keepVm (debug/inspect) disables retries.
        const maxAttempts = options.keepVm
            ? 1
            : Math.max(
                  1,
                  Number.parseInt(
                      process.env.CF_BUILD_ATTEMPTS ?? (isWindows ? '3' : '1'),
                      10
                  ) || 1
              )
        try {
            let lastErr: unknown
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    if (attempt > 1) {
                        onLine?.(
                            `[retry] build attempt ${attempt}/${maxAttempts}`
                        )
                    }
                    await remoteStreaming(
                        env.SSH_TARGET,
                        `${watchdog}${remoteEnv} ${packerArgs.join(' ')}`,
                        onLine
                    )
                    lastErr = undefined
                    break
                } catch (err) {
                    lastErr = err
                    const msg =
                        err instanceof Error ? err.message.split('\n')[0] : err
                    if (attempt < maxAttempts) {
                        onLine?.(
                            `[retry] attempt ${attempt}/${maxAttempts} failed: ${msg}`
                        )
                    }
                }
            }
            if (lastErr) throw lastErr
        } finally {
            unregisterVmCleanup?.()
        }
    } finally {
        await slot?.release()
    }

    return { startedAt }
}

// ── Phase 3: per-recipe artifact pull ────────────────────────────────────────

export type SyncPhaseOptions = {
    concurrency?: number
    onProgress?: OnProgress
    /** Only pull files with mtime >= this remote epoch (seconds). Filters out
     *  stale artifacts from prior runs that the current build didn't rewrite. */
    since?: number
}

// Pulls just this recipe's artifacts from the remote out-dir. Matches by the
// recipe name prefix so a parallel run for another recipe isn't accidentally
// downloaded.
export const syncPhase = async (
    env: Env,
    recipe: RecipeInfo,
    opts: SyncPhaseOptions = {}
): Promise<void> => {
    const remoteOutDir = buildRemoteOutDir(env)
    // `%T@` is the file's mtime in epoch seconds (with fractional part).
    const listOut = await captureRemote(
        env.SSH_TARGET,
        `find ${shellQuote(remoteOutDir)} -maxdepth 1 -type f -printf '%T@ %f\\n' 2>/dev/null || true`
    )
    // Slack window: tolerate small clock skew or sub-second rounding between
    // the `date +%s` we captured and the file's mtime as reported by find.
    const sinceSlack = 2
    const minMtime = opts.since !== undefined ? opts.since - sinceSlack : 0
    const matching = listOut
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .map(line => {
            const sp = line.indexOf(' ')
            if (sp < 0) return null
            const mtime = Number.parseFloat(line.slice(0, sp))
            const name = line.slice(sp + 1)
            return Number.isFinite(mtime) ? { name, mtime } : null
        })
        .filter((x): x is { name: string; mtime: number } => x !== null)
        .filter(
            ({ name, mtime }) =>
                (name.startsWith(recipe.name + '-') ||
                    name.startsWith(recipe.name + '.')) &&
                mtime >= minMtime
        )
        .map(x => x.name)
    if (matching.length === 0) return

    const { mkdirSync } = await import('node:fs')
    mkdirSync(env.CF_OUT_DIR, { recursive: true })

    // Pull individual files with scp via SFTP — but sftpDownload walks a dir.
    // Use sftpDownload against the out-dir but with file allow-list filter.
    // Simpler: stage matching files into a per-recipe tmpdir then download.
    const stage = `${buildRemoteTmpDir(env)}/sync-${recipe.name}-${Date.now()}`
    await captureRemote(
        env.SSH_TARGET,
        `mkdir -p ${shellQuote(stage)} && cd ${shellQuote(remoteOutDir)} && for f in ${matching.map(shellQuote).join(' ')}; do ln -f "$f" ${shellQuote(stage)}/"$f"; done`
    )
    try {
        await sftpDownload(env.SSH_TARGET, stage, env.CF_OUT_DIR, {
            concurrency: opts.concurrency ?? env.CF_DOWNLOAD_CONCURRENCY,
            onProgress: opts.onProgress,
        })
    } finally {
        await captureRemote(
            env.SSH_TARGET,
            `rm -rf ${shellQuote(stage)}`
        ).catch(() => {})
    }
}
