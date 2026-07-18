import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Env } from '@/env.ts'
import type { RecipeInfo } from '@/config.ts'
import { shellQuote } from '@/util.ts'
import {
    captureRemote,
    registerCleanup,
    remoteStreaming,
    remoteStreamingScript,
} from '@/build/remote.ts'
import {
    assertPackerTmpDirSocketSafe,
    buildPackerVars,
    buildRemoteEnv,
    PACKER_TMP_ROOT,
    packerTmpDir,
} from '@/build/packer.ts'
import {
    buildRemoteOutDir,
    buildRemoteTmpDir,
    buildRemoteWorkDir,
    remotePaths,
} from '@/build/paths.ts'
import { allocateBuildSlot, type BuildSlot } from '@/build/netslot.ts'
import { buildVmWatchdog } from '@/build/watchdog.ts'
import { bridgeForRecipe, inspectRecipeLayout } from '@/build/recipe.ts'
import { buildAttemptCount, runWithRetries } from '@/build/retry.ts'
import { buildSlotVmid, destroyVmCommand } from '@/build/vm.ts'
import {
    buildDiagnosticsRecorder,
    collectDiagnostics,
    diagnosticsRemoteDir,
    guestLogSpecs,
    recorderLifetimeSec,
    sweepStaleDiagnosticsCommand,
} from '@/build/diagnostics.ts'
import { log } from '@/log.ts'
import { acquireRunLease } from '@/build/lease.ts'

export type BuildPhaseOptions = {
    keepVm?: boolean
    skipUpload?: boolean
    ciMode?: boolean
    /** Immutable repository snapshot selected by this pipeline invocation. */
    snapshotDir?: string
}

export type BuildPhaseResult = {
    /** Remote epoch (seconds) captured before packer ran. Used by syncPhase
     *  to filter out stale artifacts left by prior runs. */
    startedAt: number
}

export const buildWritableRepoCommand = (
    snapshotWorkDir: string,
    buildWorkDir: string,
    cloudbaseCache?: string
): string => {
    const commands = [
        `cp -aL ${shellQuote(snapshotWorkDir)} ${shellQuote(buildWorkDir)}`,
        `chmod -R u+w ${shellQuote(buildWorkDir)}`,
    ]
    if (cloudbaseCache) {
        commands.push(
            `install -m 0644 ${shellQuote(cloudbaseCache)} ${shellQuote(`${buildWorkDir}/recipes/_shared/CloudbaseInitSetup_x64.msi`)}`
        )
    }
    return commands.join(' && ')
}

export const buildPhase = async (
    env: Env,
    recipe: RecipeInfo,
    options: BuildPhaseOptions = {},
    onLine?: (line: string) => void
): Promise<BuildPhaseResult> => {
    const remoteWorkDir = options.snapshotDir ?? buildRemoteWorkDir(env)
    const remoteOutDir = buildRemoteOutDir(env)
    const remoteTmpDir = buildRemoteTmpDir(env)
    const layout = await inspectRecipeLayout(recipe)
    const buildBridge = bridgeForRecipe(env, recipe, layout)
    const runId = randomUUID()
    const remoteBuildTmpDir = `${remoteTmpDir}/build-${recipe.name}-${runId}`
    // Keep Packer's Linux plugin socket out of the descriptive workspace path:
    // sockaddr_un allows only 107 pathname bytes, including every TMPDIR byte.
    const remotePackerTmpDir = packerTmpDir(runId)
    assertPackerTmpDirSocketSafe(remotePackerTmpDir)
    const remoteBuildWorkDir = `${remoteBuildTmpDir}/repo`
    const lease = await acquireRunLease(
        env,
        'build',
        recipe,
        remoteBuildTmpDir,
        {
            preserveVm: Boolean(options.keepVm),
            packerTmpDir: remotePackerTmpDir,
            onWait: message => onLine?.(`[queue] ${message}`),
        }
    )
    let slot: BuildSlot | null = null
    let unregisterSecretCleanup: (() => void) | undefined
    let secretCleanupCmd = `rm -rf ${shellQuote(remoteBuildTmpDir)} ${shellQuote(remotePackerTmpDir)}`
    let startedAt = 0
    let effectiveBuildVmid: number | undefined

    try {
        if (layout.needsBuildNetwork) {
            slot = await allocateBuildSlot(env)
            log.info(
                `build network · ${env.CF_BUILD_BRIDGE} · ${slot.ip} via ${slot.gw} · slot ${slot.slotIndex}`
            )
        }
        effectiveBuildVmid = recipe.buildVmid
            ? buildSlotVmid(recipe.buildVmid, slot)
            : undefined
        if (effectiveBuildVmid !== undefined)
            await lease.setVmid(effectiveBuildVmid)

        // The injector keeps answer-file ISOs and ephemeral credentials in the
        // dump-backed workspace; Packer keeps its socket and transient scripts
        // in the separate short directory. Both are private and run-scoped.
        // Diagnostics are keyed by the unique VMID.
        const diagEnabled =
            env.CF_DIAGNOSTICS && effectiveBuildVmid !== undefined
        const diagRemoteDir = diagEnabled
            ? diagnosticsRemoteDir(effectiveBuildVmid as number)
            : undefined
        secretCleanupCmd = `rm -rf ${[
            remoteBuildTmpDir,
            remotePackerTmpDir,
            diagRemoteDir,
        ]
            .filter((p): p is string => p !== undefined)
            .map(shellQuote)
            .join(' ')}`

        // The run lease serializes duplicate recipes, so these stable result
        // names cannot be removed or replaced by another live build.
        const stalePrefix = `${remoteOutDir}/${recipe.name}-${recipe.arch}`
        const startedAtRaw = await captureRemote(
            env.SSH_TARGET,
            `${sweepStaleDiagnosticsCommand()}; ` +
                `rm -f ${shellQuote(stalePrefix + '.vma.zst')} ${shellQuote(stalePrefix + '.json')} ${shellQuote(stalePrefix + '.json.tmp')} && date +%s`
        )
        startedAt = Number.parseInt(startedAtRaw.trim(), 10)
        if (!Number.isFinite(startedAt)) {
            throw new Error(`could not parse remote epoch: ${startedAtRaw}`)
        }

        await captureRemote(
            env.SSH_TARGET,
            `rm -rf ${shellQuote(remoteBuildTmpDir)} ${shellQuote(remotePackerTmpDir)} && ` +
                `install -d -m 700 ${shellQuote(PACKER_TMP_ROOT)} ${shellQuote(remoteBuildTmpDir)} ${shellQuote(remotePackerTmpDir)} && ${buildWritableRepoCommand(
                    remoteWorkDir,
                    remoteBuildWorkDir,
                    layout.isWindows
                        ? `${remotePaths(env).assetCache}/CloudbaseInitSetup_x64.msi`
                        : undefined
                )}`
        )
        unregisterSecretCleanup = registerCleanup(() => {
            spawnSync('ssh', [env.SSH_TARGET, secretCleanupCmd], {
                stdio: 'ignore',
            })
        })
        const injectEnv = [
            `RUNNER_TEMP=${shellQuote(remoteBuildTmpDir)}`,
            `CF_BUILD_IP=${shellQuote(slot?.ip ?? '')}`,
            `CF_BUILD_GW=${shellQuote(slot?.gw ?? '')}`,
            `CF_BUILD_DNS=${shellQuote(env.CF_BUILD_DNS)}`,
        ].join(' ')
        const varsFile = (
            await captureRemote(
                env.SSH_TARGET,
                `cd ${remoteBuildWorkDir} && ${injectEnv} bash scripts/inject-placeholders.sh ${recipe.name}`
            )
        ).trim()

        const recipeHcl = `${remoteBuildWorkDir}/recipes/${recipe.name}.pkr.hcl`

        await remoteStreaming(
            env.SSH_TARGET,
            `flock -x /var/lib/cofoundry/packer-init.lock packer init ${shellQuote(recipeHcl)}`,
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
                slot ? { ip: slot.ip, gw: slot.gw, mac: slot.mac } : null,
                effectiveBuildVmid
            ),
            recipeHcl,
        ]
        const remoteEnv = buildRemoteEnv(
            env,
            remoteOutDir,
            remotePackerTmpDir,
            recipe.arch,
            recipe.group ?? '',
            recipe.finalDiskSize,
            recipe.buildVmid,
            options.skipUpload
        )

        const cleanupVmid = effectiveBuildVmid
        const unregisterVmCleanup =
            cleanupVmid && !options.keepVm
                ? registerCleanup(() => {
                      process.stderr.write(
                          `\ncancelled — destroying build VM ${cleanupVmid}\n`
                      )
                      const destroyCmd = destroyVmCommand(
                          cleanupVmid,
                          env.CF_STORAGE
                      )
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
        const communicatorPort = layout.isWindows ? 5985 : 22
        const watchdog =
            effectiveBuildVmid && slot
                ? buildVmWatchdog(
                      effectiveBuildVmid,
                      slot.ip,
                      communicatorPort,
                      layout.isWindows
                  )
                : ''
        // Screenshot/log recorder. Emitted AFTER the watchdog so its EXIT/signal
        // traps supersede the watchdog's — it re-kills $_WDOG_PID too, so both
        // subshells tear down together.
        const recorder = diagEnabled
            ? buildDiagnosticsRecorder(effectiveBuildVmid as number, {
                  maxLifetimeSec: recorderLifetimeSec(layout.isWindows),
                  guestLogs: guestLogSpecs(recipe.group),
              })
            : ''
        // Windows builds intermittently fail mid-install (component-store
        // corruption in the specialize pass) on busy nodes. Retry the whole
        // packer build — `-force` recreates the VM from scratch each attempt,
        // so a retry is a clean install, not a resume. Override with
        // CF_BUILD_ATTEMPTS; keepVm (debug/inspect) disables retries.
        const maxAttempts = buildAttemptCount(
            layout.isWindows,
            Boolean(options.keepVm),
            env.CF_BUILD_ATTEMPTS
        )
        let lastAttempt = 0
        try {
            await runWithRetries(
                maxAttempts,
                async attempt => {
                    lastAttempt = attempt
                    await remoteStreamingScript(
                        env.SSH_TARGET,
                        `${watchdog}${recorder}${remoteEnv} ${packerArgs.join(' ')}`,
                        onLine
                    )
                },
                onLine
            )
        } catch (err) {
            // Collect BEFORE the outer finally wipes the vars file (the source of
            // the ephemeral secret used to scrub logs) and the tmpfs recorder dir.
            if (diagEnabled) {
                await collectDiagnostics({
                    env,
                    recipe,
                    vmid: effectiveBuildVmid as number,
                    isWindows: layout.isWindows,
                    varsFile,
                    ciMode: Boolean(options.ciMode),
                    attempt: lastAttempt,
                    error: err,
                })
            }
            throw err
        } finally {
            unregisterVmCleanup?.()
        }
    } finally {
        // The injector modifies only this build's writable snapshot copy. The
        // private temp tree also contains vars files, private keys, and
        // generated answer-file ISOs, so remove the whole tree together.
        unregisterSecretCleanup?.()
        if (effectiveBuildVmid !== undefined && !options.keepVm) {
            await captureRemote(
                env.SSH_TARGET,
                destroyVmCommand(effectiveBuildVmid, env.CF_STORAGE)
            ).catch(() => {})
        }
        await captureRemote(env.SSH_TARGET, secretCleanupCmd).catch(() => {})
        await slot?.release()
        await lease.release()
    }

    return { startedAt }
}
