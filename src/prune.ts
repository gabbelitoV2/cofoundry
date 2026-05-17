import { spawn } from 'node:child_process'
import type { Env } from './env.ts'
import { log } from './log.ts'

const REMOTE_WORK_DIR = '/tmp/cofoundry'
const ISO_STORE_DIR = '/var/lib/vz/template/iso'
const ISO_CACHE_DIR = '/var/lib/cofoundry/iso-cache'
const DUMP_DIR = '/var/lib/vz/dump'

export async function runClean(env: Env): Promise<void> {
    log.step(`removing ${REMOTE_WORK_DIR} on ${env.SSH_TARGET}`)
    const workSize = await ssh(
        env.SSH_TARGET,
        `du -sh ${REMOTE_WORK_DIR} 2>/dev/null | cut -f1 || echo "(not present)"`
    )
    log.info(`working dir was ${workSize}`)
    await ssh(env.SSH_TARGET, `rm -rf ${REMOTE_WORK_DIR}`)

    // Remove all Packer-uploaded ISOs from Proxmox ISO storage.
    // Packer uploads the main ISO, VirtIO ISO, and an ephemeral answerfiles CD
    // per build — none are cleaned up by the plugin. The iso-cache is the
    // persistent copy; Proxmox storage is just a staging area.
    log.step(`removing uploaded ISOs from ${ISO_STORE_DIR}`)
    const isos = (
        await ssh(
            env.SSH_TARGET,
            // Match packer*.iso (answerfiles CDs) and sha1-hash-named ISOs (uploaded by Packer).
            `find ${ISO_STORE_DIR} -maxdepth 1 \\( -name 'packer*.iso' -o -regextype posix-extended -regex '.*\/[0-9a-f]{40}\\.iso' \\) 2>/dev/null || true`
        )
    )
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)

    if (isos.length === 0) {
        log.info('no uploaded ISOs found')
    } else {
        const sizes = await ssh(
            env.SSH_TARGET,
            `du -sh ${isos.map(shellQuote).join(' ')} | cut -f1`
        )
        for (const f of isos)
            await ssh(env.SSH_TARGET, `rm -f ${shellQuote(f)}`)
        log.info(
            `removed ${isos.length} ISO(s) — ${sizes.split('\n').join(', ')}`
        )
    }

    // Remove stale vzdump artifacts and log files for build VMIDs (91xx, 92xx).
    // These are left behind if a build's mv fails (e.g. tmpfs full) or if vzdump
    // produces a .log file that is never removed after the archive is moved.
    log.step(`removing stale dump files from ${DUMP_DIR}`)
    const dumps = (
        await ssh(
            env.SSH_TARGET,
            `find ${DUMP_DIR} -maxdepth 1 \\( -name 'vzdump-qemu-91??-*' -o -name 'vzdump-qemu-92??-*' \\) 2>/dev/null || true`
        )
    )
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)

    if (dumps.length === 0) {
        log.info('no stale dump files found')
    } else {
        for (const f of dumps)
            await ssh(env.SSH_TARGET, `rm -f ${shellQuote(f)}`)
        log.info(`removed ${dumps.length} dump file(s)`)
    }

    log.ok('clean done')
}

export async function runPrune(env: Env, days: number): Promise<void> {
    // Always remove Packer's ephemeral answerfiles CDs (packer<random>.iso).
    // These are uploaded per build and never cleaned up by the plugin.
    log.step('prune ephemeral Packer ISOs from Proxmox ISO storage')
    const packerIsos = (
        await ssh(
            env.SSH_TARGET,
            `find ${ISO_STORE_DIR} -maxdepth 1 -name 'packer*.iso' 2>/dev/null || true`
        )
    )
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)

    if (packerIsos.length === 0) {
        log.info('no ephemeral Packer ISOs found')
    } else {
        for (const f of packerIsos) {
            await ssh(env.SSH_TARGET, `rm -f ${shellQuote(f)}`)
            log.info(`removed ${f}`)
        }
        log.ok(`removed ${packerIsos.length} ephemeral ISO(s)`)
    }

    // Remove iso-cache entries older than --days (large downloads, keep recent ones).
    log.step(`prune iso-cache files older than ${days} day(s)`)
    const oldIsos = (
        await ssh(
            env.SSH_TARGET,
            `find ${ISO_CACHE_DIR} -maxdepth 1 -name '*.iso' -mtime +${days} 2>/dev/null || true`
        )
    )
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)

    if (oldIsos.length === 0) {
        log.info(`no iso-cache files older than ${days} days`)
    } else {
        for (const f of oldIsos) {
            await ssh(env.SSH_TARGET, `rm -f ${shellQuote(f)}`)
            log.info(`removed ${f}`)
        }
        log.ok(`removed ${oldIsos.length} stale ISO(s) from cache`)
    }

    // Destroy any VMs lingering at build VMIDs (91xx, 92xx range).
    // Packer cleans up on success and via its -force flag at next build start,
    // but an interrupted build (SIGKILL, node crash) can leave a VM behind.
    // Base template VMIDs (90xx) are intentionally excluded.
    log.step('destroy orphaned build VMs (91xx / 92xx range)')
    const orphans = (
        await ssh(
            env.SSH_TARGET,
            `qm list 2>/dev/null | awk 'NR>1 && $1 ~ /^9[12][0-9][0-9]$/ {print $1}' || true`
        )
    )
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)

    if (orphans.length === 0) {
        log.info('no orphaned build VMs found')
    } else {
        for (const vmid of orphans) {
            log.info(`destroying VM ${vmid}`)
            await ssh(
                env.SSH_TARGET,
                `qm stop ${vmid} --skiplock 1 2>/dev/null || true; qm destroy ${vmid} --purge 1 --destroy-unreferenced-disks 1 2>/dev/null || true`
            )
        }
        log.ok(`destroyed ${orphans.length} orphaned VM(s)`)
    }

    log.ok('prune done')
}

function shellQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`
}

function ssh(target: string, cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        let out = ''
        const child = spawn('ssh', [target, cmd], {
            env: process.env as Record<string, string>,
            stdio: ['inherit', 'pipe', 'inherit'],
        })
        child.stdout!.on('data', (chunk: Buffer) => {
            out += chunk.toString()
        })
        child.on('error', reject)
        child.on('exit', code => {
            if (code === 0) resolve(out.trim())
            else
                reject(
                    new Error(`ssh command exited with code ${code}: ${cmd}`)
                )
        })
    })
}
