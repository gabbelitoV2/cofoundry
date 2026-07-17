import { spawnSync } from 'node:child_process'
import type { Env } from '@/env.ts'
import type { RecipeInfo } from '@/config.ts'
import { shellQuote } from '@/util.ts'
import {
    captureRemote,
    registerCleanup,
    remoteStreaming,
    remoteStreamingScript,
} from '@/build/remote.ts'
import { buildPackerVars, buildRemoteEnv } from '@/build/packer.ts'
import {
    buildRemoteOutDir,
    buildRemoteTmpDir,
    buildRemoteWorkDir,
} from '@/build/paths.ts'
import { allocateBuildSlot, type BuildSlot } from '@/build/netslot.ts'
import { buildVmWatchdog } from '@/build/watchdog.ts'
import {
    bridgeForRecipe,
    injectedRecipeFiles,
    inspectRecipeLayout,
} from '@/build/recipe.ts'
import { buildAttemptCount, runWithRetries } from '@/build/retry.ts'
import { buildSlotVmid, destroyVmCommand } from '@/build/vm.ts'

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
    const layout = await inspectRecipeLayout(recipe)
    const buildBridge = bridgeForRecipe(env, recipe, layout)

    let slot: BuildSlot | null = null
    if (layout.needsBuildNetwork) {
        slot = await allocateBuildSlot(env)
    }
    const effectiveBuildVmid = recipe.buildVmid
        ? buildSlotVmid(recipe.buildVmid, slot)
        : undefined
    // Packer creates answer-file ISOs and the injector writes ephemeral SSH /
    // WinRM credentials under TMPDIR. Isolate each build so mode 0700 on the
    // parent protects even tools that create individual files as 0644, and so
    // cleanup never races another recipe's active build.
    const remoteBuildTmpDir = `${remoteTmpDir}/build-${recipe.name}-${effectiveBuildVmid ?? 'plain'}`
    const injectedFiles = injectedRecipeFiles(remoteWorkDir, recipe, layout)
    const secretCleanupCmd = `rm -rf ${[remoteBuildTmpDir, ...injectedFiles]
        .map(shellQuote)
        .join(' ')}`
    let unregisterSecretCleanup: (() => void) | undefined

    if (recipe.buildVmid) {
        // Kill any orphaned packer build (and its watchdog subshells) for THIS
        // recipe left over from a cancelled/failed/timed-out run. Remote SSH
        // doesn't reliably signal the node-side packer when a run is torn down,
        // so it keeps running. Historically every recipe used a fixed
        // build_vmid, so stale packers/watchdogs could stop/start the next live
        // build's VM. New builds use a slot-derived VMID, but we still kill stale
        // recipe-local packers to prevent artifact races, then clean the legacy
        // VMID and this build's assigned VMID.
        // Match packer (and its watchdog subshell, whose argv embeds the packer
        // command) by command line. The leading [p] character class is the
        // classic self-exclusion trick: this pkill's OWN shell has the pattern
        // string in its argv, but "[p]acker" matches the literal "packer", not
        // the bracketed "[p]acker" in our own command line — so it can't SIGKILL
        // itself (which previously failed the build with ssh exit 255).
        const staleMatch = `[p]acker build .*${recipe.name}`
        const vmidsToClean = [recipe.buildVmid, effectiveBuildVmid]
            .filter((vmid): vmid is number => vmid !== undefined)
            .filter((vmid, i, vmids) => vmids.indexOf(vmid) === i)
        await captureRemote(
            env.SSH_TARGET,
            `pkill -9 -f ${shellQuote(staleMatch)} >/dev/null 2>&1 || true; ` +
                `sleep 1; ` +
                vmidsToClean.map(destroyVmCommand).join('; ')
        )
    }

    try {
        await captureRemote(
            env.SSH_TARGET,
            `rm -rf ${shellQuote(remoteBuildTmpDir)} && install -d -m 700 ${shellQuote(remoteBuildTmpDir)}`
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
                slot ? { ip: slot.ip, gw: slot.gw, mac: slot.mac } : null,
                effectiveBuildVmid
            ),
            recipeHcl,
        ]
        const remoteEnv = buildRemoteEnv(
            env,
            remoteOutDir,
            remoteBuildTmpDir,
            recipe.arch,
            recipe.group ?? '',
            recipe.finalDiskSize,
            recipe.buildVmid
        )

        const unregisterVmCleanup =
            effectiveBuildVmid && !options.keepVm
                ? registerCleanup(() => {
                      process.stderr.write(
                          `\ncancelled — destroying build VM ${effectiveBuildVmid}\n`
                      )
                      const destroyCmd = destroyVmCommand(effectiveBuildVmid)
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
        try {
            await runWithRetries(
                maxAttempts,
                async () => {
                    await remoteStreamingScript(
                        env.SSH_TARGET,
                        `${watchdog}${remoteEnv} ${packerArgs.join(' ')}`,
                        onLine
                    )
                },
                onLine
            )
        } finally {
            unregisterVmCleanup?.()
        }
    } finally {
        // The injector modifies the remote recipe copy in place. Delete those
        // generated copies after Packer has consumed them; the next repo sync
        // restores the committed placeholder versions. The private temp tree
        // contains vars files, private keys, and generated answer-file ISOs.
        unregisterSecretCleanup?.()
        await captureRemote(env.SSH_TARGET, secretCleanupCmd).catch(() => {})
        await slot?.release()
    }

    return { startedAt }
}
