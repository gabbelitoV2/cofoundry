import { execa } from 'execa'
import type { Env } from './env.ts'
import { log } from './log.ts'
import { shellQuote } from './util.ts'

const REMOTE_WORK_DIR = '/tmp/cofoundry'
const ISO_STORE_DIR = '/var/lib/vz/template/iso'
const ISO_CACHE_DIR = '/var/lib/cofoundry/iso-cache'
const DUMP_DIR = '/var/lib/vz/dump'

const ssh = async (target: string, cmd: string): Promise<string> => {
    const { stdout } = await execa('ssh', [target, cmd], {
        stdin: 'inherit',
        stderr: 'inherit',
    })
    return stdout.trim()
}

const lines = (s: string): string[] =>
    s
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)

export const runClean = async (env: Env): Promise<void> => {
    log.step(`removing ${REMOTE_WORK_DIR} on ${env.SSH_TARGET}`)
    const workSize = await ssh(
        env.SSH_TARGET,
        `du -sh ${REMOTE_WORK_DIR} 2>/dev/null | cut -f1 || echo "(not present)"`
    )
    log.info(`working dir was ${workSize}`)
    await ssh(env.SSH_TARGET, `rm -rf ${REMOTE_WORK_DIR}`)

    log.step(`removing uploaded ISOs from ${ISO_STORE_DIR}`)
    const isos = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${ISO_STORE_DIR} -maxdepth 1 \\( -name 'packer*.iso' -o -regextype posix-extended -regex '.*\/[0-9a-f]{40}\\.iso' \\) 2>/dev/null || true`
        )
    )

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

    log.step(`removing stale dump files from ${DUMP_DIR}`)
    const dumps = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${DUMP_DIR} -maxdepth 1 \\( -name 'vzdump-qemu-91??-*' -o -name 'vzdump-qemu-92??-*' \\) 2>/dev/null || true`
        )
    )

    if (dumps.length === 0) {
        log.info('no stale dump files found')
    } else {
        for (const f of dumps)
            await ssh(env.SSH_TARGET, `rm -f ${shellQuote(f)}`)
        log.info(`removed ${dumps.length} dump file(s)`)
    }

    log.ok('clean done')
}

export const runPrune = async (env: Env, days: number): Promise<void> => {
    log.step('prune ephemeral Packer ISOs from Proxmox ISO storage')
    const packerIsos = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${ISO_STORE_DIR} -maxdepth 1 -name 'packer*.iso' 2>/dev/null || true`
        )
    )

    if (packerIsos.length === 0) {
        log.info('no ephemeral Packer ISOs found')
    } else {
        for (const f of packerIsos) {
            await ssh(env.SSH_TARGET, `rm -f ${shellQuote(f)}`)
            log.info(`removed ${f}`)
        }
        log.ok(`removed ${packerIsos.length} ephemeral ISO(s)`)
    }

    log.step(`prune iso-cache files older than ${days} day(s)`)
    const oldIsos = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${ISO_CACHE_DIR} -maxdepth 1 -name '*.iso' -mtime +${days} 2>/dev/null || true`
        )
    )

    if (oldIsos.length === 0) {
        log.info(`no iso-cache files older than ${days} days`)
    } else {
        for (const f of oldIsos) {
            await ssh(env.SSH_TARGET, `rm -f ${shellQuote(f)}`)
            log.info(`removed ${f}`)
        }
        log.ok(`removed ${oldIsos.length} stale ISO(s) from cache`)
    }

    log.step('destroy orphaned build VMs (91xx / 92xx range)')
    const orphans = lines(
        await ssh(
            env.SSH_TARGET,
            `qm list 2>/dev/null | awk 'NR>1 && $1 ~ /^9[12][0-9][0-9]$/ {print $1}' || true`
        )
    )

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
