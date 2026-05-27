import { execa } from 'execa'
import { basename, join } from 'node:path'
import type { Env } from './env.ts'
import type { RecipeInfo } from './config.ts'
import { log } from './log.ts'
import { shellQuote } from './util.ts'

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
    const local = join(env.CF_OUT_DIR, `${recipe.name}-${recipe.arch}.vma.zst`)
    if (!(await Bun.file(local).exists())) {
        throw new Error(`artifact not found: ${local}`)
    }

    const remoteTmp = `/var/tmp/cofoundry-verify-${process.pid}`
    const remoteFile = `${remoteTmp}/${basename(local)}`

    log.step(`verify ${recipe.name}: uploading artifact to ${env.SSH_TARGET}`)
    await ssh(env.SSH_TARGET, `mkdir -p ${shellQuote(remoteTmp)}`)
    await execa('scp', [local, `${env.SSH_TARGET}:${remoteFile}`], {
        stdin: 'inherit',
        stderr: 'inherit',
    })

    const vmid = await pickScratchVmid(env.SSH_TARGET)
    log.step(`verify ${recipe.name}: qmrestore → VMID ${vmid}`)

    let restored = false
    try {
        await ssh(
            env.SSH_TARGET,
            `qmrestore ${shellQuote(remoteFile)} ${vmid} --storage ${shellQuote(env.CF_STORAGE)} --unique 1`
        )
        restored = true

        log.step(`verify ${recipe.name}: qm start ${vmid}`)
        await ssh(env.SSH_TARGET, `qm start ${vmid}`)

        log.step(
            `verify ${recipe.name}: waiting up to ${GUEST_PING_TIMEOUT_S}s for guest agent`
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
        log.ok(`verify ${recipe.name}: guest agent responded`)
    } finally {
        if (restored) await destroyVm(env.SSH_TARGET, vmid)
        await sshOk(env.SSH_TARGET, `rm -rf ${shellQuote(remoteTmp)}`)
    }
}
