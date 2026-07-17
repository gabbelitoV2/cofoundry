import { confirm, input, select } from '@inquirer/prompts'
import pc from 'picocolors'
import { log } from '@/log.ts'
import type {
    BootstrapPlan as Plan,
    BootstrapScope as Scope,
    BootstrapStep as Step,
    ProbeResult,
} from '@/bootstrap/model.ts'
import { sshCapture, sshOk } from '@/bootstrap/remote.ts'
import { ALL_STEPS, parseSizeToBytes, stepToken } from '@/bootstrap/steps.ts'
import type { PartialEnv } from '@/env.ts'

// ── .env updater ──────────────────────────────────────────────────────────────

const ENV_PATH = '.env'

const upsertEnvFile = async (kvs: Record<string, string>): Promise<void> => {
    const file = Bun.file(ENV_PATH)
    let content = ''
    if (await file.exists()) content = await file.text()
    const lines = content === '' ? [] : content.split('\n')
    // Drop trailing empty line so we don't get a double newline.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const seen = new Set<string>()
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=/)
        if (m && kvs[m[1]!] !== undefined) {
            lines[i] = `${m[1]}=${kvs[m[1]!]}`
            seen.add(m[1]!)
        }
    }
    for (const [k, v] of Object.entries(kvs)) {
        if (!seen.has(k)) lines.push(`${k}=${v}`)
    }
    await Bun.write(ENV_PATH, lines.join('\n') + '\n')
}

// ── interactive flow ──────────────────────────────────────────────────────────

const scopeFlags = (scope: Scope) => ({
    // The NAT bridge backs every recipe that can't rely on the qemu-guest-agent
    // for IP discovery — i.e. all ISO installers (Debian/Ubuntu/Alma/Rocky/Windows).
    // Cloud-image-only builds use the LAN bridge + DHCP and don't need it.
    needBuildNet: scope === 'with-installers',
    needTmpfs: scope === 'with-installers',
})

export const runBootstrap = async (initialEnv: PartialEnv): Promise<void> => {
    if (!process.stdin.isTTY) {
        throw new Error(
            'cf bootstrap must run interactively (stdin is not a TTY). It is a one-time setup, not for CI.'
        )
    }

    // 1. SSH_TARGET
    let target = initialEnv.SSH_TARGET
    if (!target) {
        target = await input({
            message:
                'SSH target for the Proxmox node (e.g. root@pve.example.com)',
            validate: v => v.includes('@') || 'expected user@host',
        })
        log.step(`testing ssh ${target}`)
        const ok = await sshOk(target, 'true')
        if (!ok) {
            throw new Error(
                `ssh ${target} true failed — fix passwordless ssh first (ssh-copy-id), then re-run`
            )
        }
        const persist = await confirm({
            message: `write SSH_TARGET=${target} to .env?`,
            default: true,
        })
        if (persist) await upsertEnvFile({ SSH_TARGET: target })
    } else {
        const ok = await sshOk(target, 'true')
        if (!ok) {
            throw new Error(
                `ssh ${target} true failed — fix passwordless ssh first, then re-run`
            )
        }
    }

    // 2. Scope
    const scope = (await select({
        message: 'What will this node build?',
        choices: [
            {
                name: 'Cloud-image Linux only (Ubuntu cloud, etc.)',
                value: 'linux-cloud' as Scope,
            },
            {
                name: 'Anything with an installer (Debian/Alma/Rocky/Ubuntu live/Windows)',
                value: 'with-installers' as Scope,
            },
        ],
    })) as Scope
    const flags = scopeFlags(scope)

    // 2b. Cluster: optionally turn each build into a clonable template on every
    // node (per-node VMID, local storage — no shared storage needed).
    const members = await sshCapture(
        target,
        `grep -c '"id":' /etc/pve/.members 2>/dev/null || echo 1`
    )
    const nodeCount = parseInt(members.stdout.trim(), 10) || 1
    if (nodeCount > 1) {
        const clusterTemplates = await confirm({
            message: `Cluster of ${nodeCount} nodes detected — restore each build as a clonable template on every node (per-node VMID via scripts/cf-cluster-templates.sh)?`,
            default: false,
        })
        if (clusterTemplates) {
            // $PVE_DUMP_DIR is exported into the post-processor env by
            // buildPostProcEnv() in src/build/packer.ts, so this resolves on
            // the PVE node regardless of how PVE_DUMP_DIR is configured.
            await upsertEnvFile({
                CF_UPLOAD_CMD:
                    'bash "$PVE_DUMP_DIR/cofoundry-work/scripts/cf-cluster-templates.sh" {{file}}',
            })
            log.ok(
                `cluster template distribution enabled — each build creates a clonable template on all ${nodeCount} nodes`
            )
        }
    }

    // 3. Token name — ask only if no 'cofoundry' (or any user-chosen) token yet.
    // Probe with default first; if it exists, no question.
    let tokenName = 'cofoundry'
    const tokenProbe = await stepToken.probe({
        target,
        scope,
        tokenName,
        ...flags,
        tmpfsSizeGB: 16,
    })
    if (!tokenProbe.done) {
        tokenName = await input({
            message: 'API token name',
            default: 'cofoundry',
        })
    }

    // 4. tmpfs size — only if in scope AND current size < 8G
    let tmpfsSizeGB = 16
    if (flags.needTmpfs) {
        const fstab = await sshCapture(
            target,
            `awk '$2=="/tmp" && $3=="tmpfs" {print $4}' /etc/fstab`
        )
        const m = fstab.stdout.trim().match(/size=([^,\s]+)/)
        const currentBytes = m ? parseSizeToBytes(m[1]!) : 0
        if (currentBytes < 8 * 1024 ** 3) {
            const answer = await input({
                message: 'tmpfs /tmp size',
                default: '16G',
                validate: v =>
                    parseSizeToBytes(v) >= 8 * 1024 ** 3 ||
                    'must be at least 8G for Windows artifacts',
            })
            tmpfsSizeGB = Math.round(parseSizeToBytes(answer) / 1024 ** 3)
        }
    }

    const plan: Plan = {
        target,
        scope,
        tokenName,
        tmpfsSizeGB,
        ...flags,
    }

    // 6. Probe everything, build checklist
    log.step('probing node state')
    const probes: Array<{ step: Step; result: ProbeResult }> = []
    for (const step of ALL_STEPS) {
        if (!step.inScope(plan)) continue
        const result = await step.probe(plan)
        probes.push({ step, result })
    }

    log.section('Plan')
    for (const { step, result } of probes) {
        const mark = result.done ? pc.green('✓') : pc.cyan('+')
        const status = result.done
            ? `${pc.dim('·')} already done${result.note ? ` ${pc.dim(`(${result.note})`)}` : ''}`
            : `${pc.dim('·')} will run${result.note ? ` ${pc.dim(`(${result.note})`)}` : ''}`
        log.raw(`  ${mark} ${step.label.padEnd(45)} ${status}`)
    }
    const skipped = ALL_STEPS.filter(s => !s.inScope(plan))
    if (skipped.length > 0) {
        log.section('Out of scope')
        for (const s of skipped) log.raw(`  ${pc.dim('-')} ${pc.dim(s.label)}`)
    }
    log.blank()

    const toApply = probes.filter(p => !p.result.done)
    if (toApply.length === 0) {
        log.ok('node is already fully configured — nothing to do')
        return
    }

    const go = await confirm({
        message: `Apply ${toApply.length} change${toApply.length === 1 ? '' : 's'}?`,
        default: true,
    })
    if (!go) {
        log.info('aborted, no changes made')
        return
    }

    // 7. Apply
    log.section('Apply')
    let createdSecret: string | undefined
    let createdTokenId: string | undefined
    for (const { step, result } of probes) {
        if (result.done) {
            log.info(
                `${step.label} ${pc.dim('·')} ${result.note ?? 'already done'}`
            )
            continue
        }
        log.step(step.label)
        const out = await step.apply(plan)
        if (out.secret) {
            createdSecret = out.secret
            createdTokenId = out.tokenId
        }
        log.ok(`${step.label} ${pc.dim('·')} ${out.note ?? 'done'}`)
    }

    // 8. Post-run: token secret
    if (createdSecret && createdTokenId) {
        log.section(pc.yellow('API token created — SAVE THIS, shown only once'))
        log.raw(`    ${pc.cyan('PVE_TOKEN_ID')}=${createdTokenId}`)
        log.raw(`    ${pc.cyan('PVE_TOKEN_SECRET')}=${createdSecret}`)
        log.blank()
        const persist = await confirm({
            message: 'append PVE_TOKEN_ID / PVE_TOKEN_SECRET to .env?',
            default: true,
        })
        if (persist) {
            await upsertEnvFile({
                PVE_TOKEN_ID: createdTokenId,
                PVE_TOKEN_SECRET: createdSecret,
            })
            log.ok('wrote .env')
        }
    }

    log.blank()
    log.ok('Bootstrap complete.')
}
