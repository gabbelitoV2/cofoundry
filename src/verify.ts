import { execa } from 'execa'
import { basename, join } from 'node:path'
import { createRenderer, title, accent, dim } from '@cofoundry/ui'
import type { Env } from './env.ts'
import type { RecipeInfo } from './config.ts'
import { shellQuote } from './util.ts'
import { buildRemoteOutDir } from './build/packer.ts'

const SCRATCH_VMID_BASE = 9500
const GUEST_PING_TIMEOUT_S = 180
const GUEST_PING_INTERVAL_S = 5

const ssh = async (target: string, cmd: string): Promise<string> => {
    const { stdout } = await execa('ssh', [target, cmd], {
        stdin: 'inherit',
        stderr: 'inherit',
    })
    return stdout
}

const sshOk = async (target: string, cmd: string): Promise<boolean> => {
    const res = await execa('ssh', [target, cmd], {
        reject: false,
        stdin: 'inherit',
        stderr: 'inherit',
    })
    return res.exitCode === 0
}

const pickScratchVmid = async (target: string): Promise<number> => {
    const inUse = new Set(
        (await ssh(target, `qm list 2>/dev/null | awk 'NR>1 {print $1}'`))
            .split('\n')
            .map(s => parseInt(s.trim(), 10))
            .filter(n => Number.isFinite(n))
    )
    for (let id = SCRATCH_VMID_BASE; id < SCRATCH_VMID_BASE + 500; id++) {
        if (!inUse.has(id)) return id
    }
    throw new Error('no free scratch VMID found in 9500-9999')
}

const destroyVm = async (target: string, vmid: number): Promise<void> => {
    await sshOk(
        target,
        `qm stop ${vmid} --skiplock 1 2>/dev/null || true; ` +
            `qm destroy ${vmid} --purge 1 --destroy-unreferenced-disks 1 2>/dev/null || true`
    )
}

const pingGuest = async (
    target: string,
    vmid: number,
    timeoutS: number,
    intervalS: number
): Promise<boolean> => {
    const deadline = Date.now() + timeoutS * 1000
    while (Date.now() < deadline) {
        const ok = await sshOk(
            target,
            `qm guest cmd ${vmid} ping >/dev/null 2>&1`
        )
        if (ok) return true
        await new Promise(r => setTimeout(r, intervalS * 1000))
    }
    return false
}

/**
 * Smoke-test the locally-built artifact by qmrestore-ing it on the PVE node,
 * booting, and waiting for the guest agent. Catches corrupt vzdump output,
 * broken cloud-init, kernel panics, missing qemu-guest-agent.
 */
export const runVerify = async (
    env: Env,
    recipe: RecipeInfo
): Promise<void> => {
    const artifactName = `${recipe.name}-${recipe.arch}.vma.zst`
    const local = join(env.CF_OUT_DIR, artifactName)
    const remoteBuildFile = `${buildRemoteOutDir(env)}/${artifactName}`
    const remoteTmp = `/var/tmp/cofoundry-verify-${process.pid}`

    // Prefer the artifact already on the PVE node from the build step
    // (CI sets CF_SKIP_SYNC_BACK=1, so it never lands locally). Fall back to
    // uploading the local file when running outside CI.
    const remoteHasBuildArtifact = await sshOk(
        env.SSH_TARGET,
        `test -f ${shellQuote(remoteBuildFile)}`
    )
    const localExists = await Bun.file(local).exists()
    if (!remoteHasBuildArtifact && !localExists) {
        throw new Error(
            `artifact not found locally (${local}) or on ${env.SSH_TARGET} (${remoteBuildFile})`
        )
    }

    const sourceFile = remoteHasBuildArtifact
        ? remoteBuildFile
        : `${remoteTmp}/${basename(local)}`
    // qmrestore parses the basename to extract VMID/type and rejects anything
    // not matching `vzdump-qemu-<vmid>-<timestamp>.vma.zst`. Our artifact is
    // named `<recipe>-<arch>.vma.zst`, so expose it to qmrestore under a
    // vzdump-shaped symlink in our scratch dir.
    const ts = new Date()
        .toISOString()
        .replace(/[-:T]/g, '_')
        .replace(/\..+$/, '')
    const vzdumpName = `vzdump-qemu-0-${ts}.vma.zst`
    const restoreFile = `${remoteTmp}/${vzdumpName}`

    const renderer = createRenderer({
        title: title(
            `Verifying ${accent(recipe.name)} ${dim('on')} ${accent(env.SSH_TARGET)}`
        ),
        outputLines: 1,
    })
    const task = renderer.task(recipe.name)
    let restored = false
    let vmid = 0

    try {
        if (remoteHasBuildArtifact) {
            task.setPhase(`using remote artifact ${dim(remoteBuildFile)}`)
            await ssh(env.SSH_TARGET, `mkdir -p ${shellQuote(remoteTmp)}`)
        } else {
            task.setPhase(`uploading artifact ${dim('→')} ${env.SSH_TARGET}`)
            await ssh(env.SSH_TARGET, `mkdir -p ${shellQuote(remoteTmp)}`)
            await execa('scp', [local, `${env.SSH_TARGET}:${sourceFile}`], {
                stdin: 'inherit',
                stderr: 'inherit',
            })
        }

        // qmrestore reads the file via its argument path; a symlink is enough.
        await ssh(
            env.SSH_TARGET,
            `ln -sf ${shellQuote(sourceFile)} ${shellQuote(restoreFile)}`
        )

        task.setPhase('allocating VMID')
        vmid = await pickScratchVmid(env.SSH_TARGET)

        task.setPhase(`qmrestore ${dim('→')} VMID ${accent(String(vmid))}`)
        await ssh(
            env.SSH_TARGET,
            `qmrestore ${shellQuote(restoreFile)} ${vmid} --storage ${shellQuote(env.CF_STORAGE)} --unique 1`
        )
        restored = true

        task.setPhase(`qm start ${vmid}`)
        await ssh(env.SSH_TARGET, `qm start ${vmid}`)

        task.setPhase(
            `waiting for guest agent ${dim(`(≤${GUEST_PING_TIMEOUT_S}s)`)}`
        )
        const ok = await pingGuest(
            env.SSH_TARGET,
            vmid,
            GUEST_PING_TIMEOUT_S,
            GUEST_PING_INTERVAL_S
        )
        if (!ok) {
            throw new Error(
                `guest agent did not respond within ${GUEST_PING_TIMEOUT_S}s`
            )
        }
        task.succeed(`guest agent responded ${dim(`(VMID ${vmid})`)}`)
    } catch (err) {
        task.fail(err instanceof Error ? err.message : String(err))
        throw err
    } finally {
        if (restored) await destroyVm(env.SSH_TARGET, vmid)
        await sshOk(env.SSH_TARGET, `rm -rf ${shellQuote(remoteTmp)}`)
        renderer.finish()
    }
}
