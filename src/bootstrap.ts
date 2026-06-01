import { execa } from 'execa'
import { confirm, input, select } from '@inquirer/prompts'
import { remoteStreaming } from './build/remote.ts'
import { log } from './log.ts'
import { addSensitiveValues, shellQuote } from './util.ts'

type Scope = 'linux-cloud' | 'with-installers'

type Plan = {
    target: string
    scope: Scope
    needBuildNet: boolean
    needTmpfs: boolean
    tokenName: string
    tmpfsSizeGB: number
}

type ProbeResult = { done: boolean; note?: string }
type ApplyResult = { note?: string; secret?: string; tokenId?: string }

type Step = {
    id: string
    label: string
    inScope: (plan: Plan) => boolean
    probe: (plan: Plan) => Promise<ProbeResult>
    apply: (plan: Plan) => Promise<ApplyResult>
}

// ── ssh helpers (probe = quiet; mutate = streamed) ────────────────────────────

const sshOk = async (target: string, cmd: string): Promise<boolean> => {
    const res = await execa('ssh', [target, cmd], {
        reject: false,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
    })
    return res.exitCode === 0
}

const sshCapture = async (
    target: string,
    cmd: string
): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
    const res = await execa('ssh', [target, cmd], {
        reject: false,
        stdin: 'ignore',
        stderr: 'pipe',
    })
    return {
        ok: res.exitCode === 0,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
    }
}

const writeRemoteFile = async (
    target: string,
    path: string,
    contents: string
): Promise<void> => {
    await execa('ssh', [target, `cat > ${shellQuote(path)}`], {
        input: contents,
        stderr: 'inherit',
    })
}

const APT_INSTALL = 'DEBIAN_FRONTEND=noninteractive apt-get install -y'

// ── parsing helpers ───────────────────────────────────────────────────────────

const parseSizeToBytes = (s: string): number => {
    const m = s.trim().match(/^(\d+)\s*([KMGTkmgt]?)$/)
    if (!m) return 0
    const n = parseInt(m[1]!, 10)
    const unit = (m[2] ?? '').toUpperCase()
    const mult =
        unit === 'K'
            ? 1024
            : unit === 'M'
              ? 1024 ** 2
              : unit === 'G'
                ? 1024 ** 3
                : unit === 'T'
                  ? 1024 ** 4
                  : 1
    return n * mult
}

// ── steps ─────────────────────────────────────────────────────────────────────

const stepToken: Step = {
    id: 'token',
    label: 'create API token',
    inScope: () => true,
    probe: async plan => {
        const r = await sshCapture(
            plan.target,
            `pveum user token list root@pam --output-format json 2>/dev/null`
        )
        if (!r.ok) return { done: false }
        let tokens: Array<{ tokenid?: string }> = []
        try {
            tokens = JSON.parse(r.stdout || '[]')
        } catch {
            return { done: false }
        }
        const exists = tokens.some(t => t.tokenid === plan.tokenName)
        return exists
            ? { done: true, note: `root@pam!${plan.tokenName} already exists` }
            : { done: false }
    },
    apply: async plan => {
        const r = await sshCapture(
            plan.target,
            `pveum user token add root@pam ${shellQuote(plan.tokenName)} --privsep=0 --output-format json`
        )
        if (!r.ok) {
            throw new Error(
                `pveum user token add failed: ${r.stderr || r.stdout}`
            )
        }
        let parsed: { 'value'?: string; 'full-tokenid'?: string } = {}
        try {
            parsed = JSON.parse(r.stdout)
        } catch {
            throw new Error(
                `could not parse pveum output as JSON: ${r.stdout.slice(0, 200)}`
            )
        }
        const secret = parsed.value
        const tokenId = parsed['full-tokenid'] ?? `root@pam!${plan.tokenName}`
        if (!secret) throw new Error('pveum returned no token value')
        addSensitiveValues(secret)
        return {
            secret,
            tokenId,
            note: `created ${tokenId}`,
        }
    },
}

const stepPacker: Step = {
    id: 'packer',
    label: 'install packer',
    inScope: () => true,
    probe: async plan =>
        (await sshOk(plan.target, 'command -v packer >/dev/null 2>&1'))
            ? { done: true, note: 'packer already installed' }
            : { done: false },
    apply: async plan => {
        const cmd = [
            'set -e',
            'install -d -m 0755 /usr/share/keyrings',
            'wget -qO- https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg',
            `echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" > /etc/apt/sources.list.d/hashicorp.list`,
            'apt-get update',
            `${APT_INSTALL} packer`,
        ].join(' && ')
        await remoteStreaming(plan.target, cmd)
        return { note: 'installed' }
    },
}

const stepAwscli: Step = {
    id: 'awscli',
    label: 'install awscli',
    inScope: () => true,
    probe: async plan =>
        (await sshOk(plan.target, 'command -v aws >/dev/null 2>&1'))
            ? { done: true, note: 'aws already installed' }
            : { done: false },
    apply: async plan => {
        await remoteStreaming(
            plan.target,
            `apt-get update && ${APT_INSTALL} awscli`
        )
        return { note: 'installed' }
    },
}

const stepIsoCache: Step = {
    id: 'iso-cache',
    label: 'create /var/lib/cofoundry/iso-cache',
    inScope: () => true,
    probe: async plan =>
        (await sshOk(plan.target, '[ -d /var/lib/cofoundry/iso-cache ]'))
            ? { done: true, note: 'already exists' }
            : { done: false },
    apply: async plan => {
        await remoteStreaming(
            plan.target,
            'mkdir -p /var/lib/cofoundry/iso-cache'
        )
        return { note: 'created' }
    },
}

const VMBR1_STANZA = `
auto vmbr1
iface vmbr1 inet static
    address 10.0.0.1/24
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    post-up   echo 1 > /proc/sys/net/ipv4/ip_forward
    post-up   iptables -t nat -A POSTROUTING -s 10.0.0.0/24 -o vmbr0 -j MASQUERADE
    post-down iptables -t nat -D POSTROUTING -s 10.0.0.0/24 -o vmbr0 -j MASQUERADE
`

const stepVmbr1: Step = {
    id: 'vmbr1',
    label: 'configure vmbr1 NAT bridge',
    inScope: plan => plan.needBuildNet,
    probe: async plan =>
        // Anchor with $ — a bare '^auto vmbr1' also matches a pre-existing
        // 'auto vmbr100' (prefix), which would skip creating vmbr1 entirely.
        (await sshOk(
            plan.target,
            `grep -q '^auto vmbr1$' /etc/network/interfaces`
        ))
            ? { done: true, note: 'vmbr1 already in /etc/network/interfaces' }
            : { done: false },
    apply: async plan => {
        await execa('ssh', [plan.target, `cat >> /etc/network/interfaces`], {
            input: VMBR1_STANZA,
            stderr: 'inherit',
        })
        await remoteStreaming(plan.target, 'ifup vmbr1')
        return { note: 'created vmbr1 + ifup' }
    },
}

const stepDnsmasq: Step = {
    id: 'dnsmasq',
    label: 'install dnsmasq',
    inScope: plan => plan.needBuildNet,
    probe: async plan =>
        (await sshOk(plan.target, 'dpkg -s dnsmasq >/dev/null 2>&1'))
            ? { done: true, note: 'dnsmasq already installed' }
            : { done: false },
    apply: async plan => {
        await remoteStreaming(plan.target, `${APT_INSTALL} dnsmasq`)
        return { note: 'installed' }
    },
}

// Per-build static reservations (10.0.0.100-149) are written by
// src/build/netslot.ts at build time into /etc/dnsmasq.d/cofoundry-hosts.d/.
// That directory is loaded via dhcp-hostsfile= rather than as regular config
// files, because dnsmasq only honours SIGHUP for entries loaded that way —
// `dhcp-host=` lines in /etc/dnsmasq.d/*.conf are parsed once at startup and
// never re-read, which silently breaks per-build reservations.
const DNSMASQ_HOSTS_DIR = '/etc/dnsmasq.d/cofoundry-hosts.d'
const DNSMASQ_CONF = `interface=vmbr1
bind-interfaces
dhcp-range=10.0.0.200,10.0.0.250,12h
dhcp-option=3,10.0.0.1
dhcp-option=6,8.8.8.8
dhcp-option=option:router,10.0.0.1
dhcp-hostsfile=${DNSMASQ_HOSTS_DIR}
`

const stepDnsmasqConf: Step = {
    id: 'dnsmasq-conf',
    label: 'write /etc/dnsmasq.d/vmbr1-nat.conf',
    inScope: plan => plan.needBuildNet,
    probe: async plan =>
        (await sshOk(
            plan.target,
            `grep -qxF 'dhcp-hostsfile=${DNSMASQ_HOSTS_DIR}' /etc/dnsmasq.d/vmbr1-nat.conf 2>/dev/null`
        ))
            ? { done: true, note: 'config already present' }
            : { done: false },
    apply: async plan => {
        // Hosts dir must exist before dnsmasq starts or it errors out.
        // Also sweep any legacy /etc/dnsmasq.d/cofoundry-slot-*.conf snippets
        // from the pre-dhcp-hostsfile layout so they don't linger as stale
        // static reservations.
        await remoteStreaming(
            plan.target,
            `mkdir -p ${DNSMASQ_HOSTS_DIR} && rm -f /etc/dnsmasq.d/cofoundry-slot-*.conf`
        )
        await writeRemoteFile(
            plan.target,
            '/etc/dnsmasq.d/vmbr1-nat.conf',
            DNSMASQ_CONF
        )
        await remoteStreaming(plan.target, 'systemctl restart dnsmasq')
        return { note: 'written + dnsmasq restarted' }
    },
}

const stepNetslotDir: Step = {
    id: 'netslot-dir',
    label: 'create /var/lib/cofoundry for netslot lock',
    inScope: plan => plan.needBuildNet,
    probe: async plan =>
        (await sshOk(plan.target, '[ -d /var/lib/cofoundry ]'))
            ? { done: true, note: 'already exists' }
            : { done: false },
    apply: async plan => {
        await remoteStreaming(plan.target, 'mkdir -p /var/lib/cofoundry')
        return { note: 'created' }
    },
}

const stepTmpfs: Step = {
    id: 'tmpfs',
    label: 'enlarge /tmp tmpfs',
    inScope: plan => plan.needTmpfs,
    probe: async plan => {
        const fstab = await sshCapture(
            plan.target,
            `awk '$2=="/tmp" && $3=="tmpfs" {print $4}' /etc/fstab`
        )
        const opts = fstab.stdout.trim()
        if (!opts) return { done: false }
        const m = opts.match(/size=([^,\s]+)/)
        if (!m) return { done: false }
        const haveBytes = parseSizeToBytes(m[1]!)
        const wantBytes = plan.tmpfsSizeGB * 1024 ** 3
        return haveBytes >= wantBytes
            ? { done: true, note: `fstab already size=${m[1]}` }
            : { done: false, note: `fstab size=${m[1]} < ${plan.tmpfsSizeGB}G` }
    },
    apply: async plan => {
        // Replace an existing tmpfs /tmp line, otherwise append one.
        const want = `tmpfs /tmp tmpfs defaults,size=${plan.tmpfsSizeGB}G 0 0`
        const cmd = `
if awk '$2=="/tmp" && $3=="tmpfs" {found=1} END {exit !found}' /etc/fstab; then
    sed -i -E 's|^[^#].*[[:space:]]/tmp[[:space:]]+tmpfs[[:space:]].*|${want.replace(/[|]/g, '\\|')}|' /etc/fstab
else
    echo '${want}' >> /etc/fstab
fi
mount -o remount /tmp
`.trim()
        await remoteStreaming(plan.target, cmd)
        return { note: `set to ${plan.tmpfsSizeGB}G + remounted` }
    },
}

const ALL_STEPS: Step[] = [
    stepToken,
    stepPacker,
    stepAwscli,
    stepIsoCache,
    stepVmbr1,
    stepDnsmasq,
    stepDnsmasqConf,
    stepNetslotDir,
    stepTmpfs,
]

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

export const runBootstrap = async (): Promise<void> => {
    if (!process.stdin.isTTY) {
        log.err(
            'cf bootstrap must run interactively (stdin is not a TTY). It is a one-time setup, not for CI.'
        )
        process.exit(1)
    }

    // 1. SSH_TARGET
    let target = process.env.SSH_TARGET
    if (!target) {
        target = await input({
            message:
                'SSH target for the Proxmox node (e.g. root@pve.example.com)',
            validate: v => v.includes('@') || 'expected user@host',
        })
        log.step(`testing ssh ${target}`)
        const ok = await sshOk(target, 'true')
        if (!ok) {
            log.err(
                `ssh ${target} true failed — fix passwordless ssh first (ssh-copy-id), then re-run`
            )
            process.exit(1)
        }
        const persist = await confirm({
            message: `write SSH_TARGET=${target} to .env?`,
            default: true,
        })
        if (persist) await upsertEnvFile({ SSH_TARGET: target })
    } else {
        const ok = await sshOk(target, 'true')
        if (!ok) {
            log.err(
                `ssh ${target} true failed — fix passwordless ssh first, then re-run`
            )
            process.exit(1)
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

    console.log('')
    console.log('Plan:')
    for (const { step, result } of probes) {
        const mark = result.done ? '✓' : '+'
        const status = result.done
            ? `already done${result.note ? ` (${result.note})` : ''}`
            : `will run${result.note ? ` (${result.note})` : ''}`
        console.log(`  ${mark} ${step.label.padEnd(45)} ${status}`)
    }
    const skipped = ALL_STEPS.filter(s => !s.inScope(plan))
    if (skipped.length > 0) {
        console.log('')
        console.log('Out of scope (skipped):')
        for (const s of skipped) console.log(`  - ${s.label}`)
    }
    console.log('')

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
    let createdSecret: string | undefined
    let createdTokenId: string | undefined
    for (const { step, result } of probes) {
        if (result.done) {
            log.info(`✓ ${step.label}: ${result.note ?? 'already done'}`)
            continue
        }
        log.step(`${step.label}`)
        const out = await step.apply(plan)
        if (out.secret) {
            createdSecret = out.secret
            createdTokenId = out.tokenId
        }
        log.ok(`${step.label}: ${out.note ?? 'done'}`)
    }

    // 8. Post-run: token secret
    if (createdSecret && createdTokenId) {
        console.log('')
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.log('  API token created — SAVE THIS, it is shown only once:')
        console.log('')
        console.log(`    PVE_TOKEN_ID=${createdTokenId}`)
        console.log(`    PVE_TOKEN_SECRET=${createdSecret}`)
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.log('')
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

    log.ok('bootstrap complete')
}
