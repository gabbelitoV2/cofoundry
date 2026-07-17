import { execa } from 'execa'
import { remoteStreaming } from '@/build/remote.ts'
import {
    BUILD_DHCP_RANGE_END,
    BUILD_DHCP_RANGE_START,
    BUILD_NET_BRIDGE_ADDR,
    BUILD_NET_CIDR,
    BUILD_NET_GATEWAY,
    BUILD_NET_PREFIX,
} from '@/build/buildnet.ts'
import { shellQuote } from '@/util.ts'
import type { BootstrapStep } from '@/bootstrap/model.ts'
import { sshCapture, sshOk, writeRemoteFile } from '@/bootstrap/remote.ts'

const APT_INSTALL = 'DEBIAN_FRONTEND=noninteractive apt-get install -y'
const DNSMASQ_CONF_PATH = '/etc/dnsmasq.d/vmbr1-nat.conf'
const DNSMASQ_HOSTS_DIR = '/etc/dnsmasq.d/cofoundry-hosts.d'

const activeDirectives = (activeConfig: string): string[] =>
    activeConfig
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => line.replace(/^.*?:\d+:/, '').replaceAll(/\s/g, ''))

const rangeAddresses = (directive: string): string[] =>
    directive
        .slice('dhcp-range='.length)
        .split(',')
        .filter(part => /^\d+\.\d+\.\d+\.\d+$/.test(part))

const isBuildRange = (directive: string): boolean => {
    if (!directive.startsWith('dhcp-range=')) return false
    const addresses = rangeAddresses(directive)
    return (
        addresses[0] === BUILD_DHCP_RANGE_START &&
        addresses[1] === BUILD_DHCP_RANGE_END
    )
}

export const dnsmasqConf = (buildDns: string, activeConfig = ''): string => {
    const directives = activeDirectives(activeConfig)
    const lines = ['# Managed by Cofoundry.']
    if (!directives.includes('interface=vmbr1')) lines.push('interface=vmbr1')
    if (
        !directives.includes('bind-interfaces') &&
        !directives.includes('bind-dynamic')
    ) {
        lines.push('bind-interfaces')
    }
    if (!directives.some(isBuildRange)) {
        lines.push(
            `dhcp-range=${BUILD_DHCP_RANGE_START},${BUILD_DHCP_RANGE_END},12h`
        )
    }
    if (
        !directives.includes(`dhcp-option=3,${BUILD_NET_GATEWAY}`) &&
        !directives.includes(`dhcp-option=option:router,${BUILD_NET_GATEWAY}`)
    ) {
        lines.push(`dhcp-option=option:router,${BUILD_NET_GATEWAY}`)
    }
    const hasDnsOption = directives.some(
        directive =>
            /^dhcp-option=(?:6|option:dns-server),/.test(directive) &&
            directive.split(',').at(-1) !== ''
    )
    if (!hasDnsOption) lines.push(`dhcp-option=6,${buildDns}`)
    if (!directives.includes(`dhcp-hostsfile=${DNSMASQ_HOSTS_DIR}`)) {
        lines.push(`dhcp-hostsfile=${DNSMASQ_HOSTS_DIR}`)
    }
    return `${lines.join('\n')}\n`
}

const VMBR1_STANZA = `
auto vmbr1
iface vmbr1 inet static
    address ${BUILD_NET_BRIDGE_ADDR}
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    post-up   echo 1 > /proc/sys/net/ipv4/ip_forward
    post-up   iptables -t nat -A POSTROUTING -s ${BUILD_NET_CIDR} -o vmbr0 -j MASQUERADE
    post-down iptables -t nat -D POSTROUTING -s ${BUILD_NET_CIDR} -o vmbr0 -j MASQUERADE
`

const activeDnsmasqConfigCmd = `{
    [ ! -f /etc/dnsmasq.conf ] || printf '%s\\0' /etc/dnsmasq.conf
    find /etc/dnsmasq.d -maxdepth 1 -type f -name '*.conf' ! -path ${shellQuote(DNSMASQ_CONF_PATH)} -print0 2>/dev/null
} | xargs -0 -r awk '
    /^[[:space:]]*($|#)/ { next }
    /^[[:space:]]*conf-dir=/ { next }
    { print FILENAME ":" FNR ":" $0 }
'`

export const dnsmasqConflict = (
    processState: string,
    activeConfig: string,
    listeners: string
): string | undefined => {
    const [countRaw, serviceState = ''] = processState.trim().split('|')
    const processCount = Number.parseInt(countRaw ?? '0', 10) || 0
    if (processCount > 1) {
        return `${processCount} dnsmasq processes are running; Cofoundry requires the single system dnsmasq service`
    }
    if (processCount === 1 && serviceState !== 'active') {
        return 'dnsmasq is running outside the system dnsmasq service; Cofoundry cannot safely reload it'
    }

    const configLines = activeConfig
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
    const buildNetDirective = configLines.find(line => {
        const directive = line.replace(/^.*?:\d+:/, '').replaceAll(/\s/g, '')
        if (!directive.startsWith('dhcp-range=')) return false
        const addresses = rangeAddresses(directive)
        const touchesBuildNet = addresses.some(address =>
            address.startsWith(`${BUILD_NET_PREFIX}.`)
        )
        return touchesBuildNet && !isBuildRange(directive)
    })
    if (buildNetDirective) {
        return `existing dnsmasq configuration has a different DHCP range in ${BUILD_NET_CIDR}: ${buildNetDirective}`
    }

    const explicitlyScoped = configLines.some(line =>
        /:\d+:\s*(interface|listen-address)\s*=/.test(line)
    )
    if (configLines.length > 0 && !explicitlyScoped) {
        return 'the existing dnsmasq configuration is not scoped with interface= or listen-address=; adding Cofoundry would change which interfaces it serves'
    }

    const wildcardSocket = listeners
        .split('\n')
        .map(line => line.trim())
        .find(
            line =>
                /dnsmasq/i.test(line) &&
                /(?:^|\s)(?:\*|0\.0\.0\.0|\[::\]|:::):(53|67)(?:\s|$)/.test(
                    line
                )
        )
    if (processCount === 1 && configLines.length === 0 && wildcardSocket) {
        return 'the existing dnsmasq service listens on all interfaces without an explicit interface= or listen-address= scope'
    }

    const conflictingListener = listeners
        .split('\n')
        .map(line => line.trim())
        .find(
            line =>
                line !== '' &&
                !/dnsmasq/i.test(line) &&
                /(?:^|\s)(?:\*|0\.0\.0\.0|\[::\]|:::|10\.0\.0\.1):(53|67)(?:\s|$)/.test(
                    line
                )
        )
    if (conflictingListener) {
        return `another service is listening on a DNS/DHCP wildcard or build-network socket: ${conflictingListener}`
    }
    return undefined
}

const ipv4ToInt = (address: string): number | undefined => {
    const octets = address.split('.').map(part => Number.parseInt(part, 10))
    if (
        octets.length !== 4 ||
        octets.some(
            octet => !Number.isInteger(octet) || octet < 0 || octet > 255
        )
    ) {
        return undefined
    }
    return octets.reduce((value, octet) => value * 256 + octet, 0)
}

const cidrRange = (cidr: string): [number, number] | undefined => {
    const [address, prefixRaw = '32'] = cidr.split('/')
    const ip = ipv4ToInt(address ?? '')
    const prefix = Number.parseInt(prefixRaw, 10)
    if (ip === undefined || prefix < 0 || prefix > 32) return undefined
    const size = 2 ** (32 - prefix)
    const start = Math.floor(ip / size) * size
    return [start, start + size - 1]
}

export const buildNetworkRouteConflict = (
    routes: string
): string | undefined => {
    const wanted = cidrRange(BUILD_NET_CIDR)!
    return routes
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '' && !/(?:^|\s)dev vmbr1(?:\s|$)/.test(line))
        .find(line => {
            const destination = line.split(/\s+/, 1)[0]
            if (!destination || destination === 'default') return false
            const range = cidrRange(destination)
            return range
                ? range[0] <= wanted[1] && wanted[0] <= range[1]
                : false
        })
}

export const hasBuildBridgeAddress = (
    configured: string,
    runtime: string
): boolean => {
    const escapedAddress = BUILD_NET_GATEWAY.replaceAll('.', '\\.')
    if (new RegExp(`\\binet\\s+${escapedAddress}/24\\b`).test(runtime)) {
        return true
    }
    if (
        new RegExp(`^\\s*address\\s+${escapedAddress}/24\\s*$`, 'm').test(
            configured
        )
    ) {
        return true
    }
    const hasAddressWithoutPrefix = new RegExp(
        `^\\s*address\\s+${escapedAddress}\\s*$`,
        'm'
    ).test(configured)
    const hasSlashNetmask = /^\s*netmask\s+24\s*$/m.test(configured)
    const hasDottedNetmask = /^\s*netmask\s+255\.255\.255\.0\s*$/m.test(
        configured
    )
    return hasAddressWithoutPrefix && (hasSlashNetmask || hasDottedNetmask)
}

const detectedBridgeAddress = (configured: string, runtime: string): string => {
    const runtimeAddress = runtime.match(/\binet\s+(\S+)/)?.[1]
    if (runtimeAddress) return runtimeAddress
    const configuredAddress = configured.match(/^\s*address\s+(\S+)/m)?.[1]
    const configuredNetmask = configured.match(/^\s*netmask\s+(\S+)/m)?.[1]
    if (!configuredAddress) return 'no IPv4 address found'
    return configuredNetmask
        ? `${configuredAddress} netmask ${configuredNetmask}`
        : configuredAddress
}

export const stepBuildNetworkPreflight: BootstrapStep = {
    id: 'build-network-preflight',
    label: 'check build-network conflicts',
    probe: async plan => {
        const [route, configTest, processState, activeConfig, listeners] =
            await Promise.all([
                sshCapture(
                    plan.target,
                    'ip -4 route show type unicast table all 2>/dev/null'
                ),
                sshCapture(
                    plan.target,
                    'command -v dnsmasq >/dev/null 2>&1 && dnsmasq --test'
                ),
                sshCapture(
                    plan.target,
                    `printf '%s|%s\\n' "$(pgrep -xc dnsmasq 2>/dev/null || true)" "$(systemctl is-active dnsmasq 2>/dev/null || true)"`
                ),
                sshCapture(plan.target, activeDnsmasqConfigCmd),
                sshCapture(
                    plan.target,
                    `{ ss -H -lntup 'sport = :53' 2>/dev/null; ss -H -lunp 'sport = :67' 2>/dev/null; } || true`
                ),
            ])

        const routeConflict = buildNetworkRouteConflict(route.stdout)
        if (routeConflict) {
            throw new Error(
                `${BUILD_NET_CIDR} overlaps an existing route outside vmbr1: ${routeConflict}`
            )
        }
        // Exit 1 means dnsmasq is installed but its current merged config is
        // invalid. Exit 127/command-not-found is expected on a fresh node.
        if (!configTest.ok && !/not found/i.test(configTest.stderr)) {
            const installed = await sshOk(
                plan.target,
                'command -v dnsmasq >/dev/null 2>&1'
            )
            if (installed) {
                throw new Error(
                    `existing dnsmasq configuration is invalid: ${configTest.stderr.trim() || 'dnsmasq --test failed'}`
                )
            }
        }
        const conflict = dnsmasqConflict(
            processState.stdout,
            activeConfig.stdout,
            listeners.stdout
        )
        if (conflict) throw new Error(`dnsmasq conflict: ${conflict}`)
        return {
            done: true,
            note: 'subnet, configuration, and listeners are safe',
        }
    },
    apply: async () => ({ note: 'no changes needed' }),
}

export const stepVmbr1: BootstrapStep = {
    id: 'vmbr1',
    label: 'configure vmbr1 NAT bridge',
    probe: async plan => {
        const [configured, runtime] = await Promise.all([
            sshCapture(plan.target, 'ifquery vmbr1 2>/dev/null'),
            sshCapture(plan.target, 'ip -4 -o addr show dev vmbr1 2>/dev/null'),
        ])
        if (configured.ok) {
            if (hasBuildBridgeAddress(configured.stdout, runtime.stdout)) {
                return { done: true, note: 'vmbr1 has the Cofoundry address' }
            }
            throw new Error(
                `vmbr1 uses ${detectedBridgeAddress(configured.stdout, runtime.stdout)}; Cofoundry requires ${BUILD_NET_BRIDGE_ADDR}`
            )
        }
        if (runtime.ok && runtime.stdout.trim() !== '') {
            throw new Error(
                'vmbr1 exists at runtime but is not managed by the node network configuration'
            )
        }
        return { done: false }
    },
    apply: async plan => {
        await execa('ssh', [plan.target, `cat >> /etc/network/interfaces`], {
            input: VMBR1_STANZA,
            stderr: 'inherit',
        })
        await remoteStreaming(plan.target, 'ifup vmbr1')
        return { note: 'created vmbr1 + ifup' }
    },
}

const BUILD_NET_FW_COMMENT = 'cofoundry build network (packer HTTP)'

// When the Proxmox firewall is enabled, the host's PVEFW-INPUT chain drops the
// build VM's connection to packer's HTTP server (preseed/kickstart fetch) on
// vmbr1 — the build then hangs at "Waiting for SSH". A pve-firewall host rule is
// the correct fix: it survives reboots AND firewall reloads, unlike a post-up
// iptables rule which pve-firewall flushes whenever it recompiles. No-op when the
// firewall is disabled (nothing to open).
export const stepBuildNetFirewall: BootstrapStep = {
    id: 'build-net-firewall',
    label: 'allow build network through Proxmox firewall',
    probe: async plan => {
        const status = await sshCapture(
            plan.target,
            'pve-firewall status 2>/dev/null'
        )
        if (!/enabled/i.test(status.stdout)) {
            return {
                done: true,
                note: 'Proxmox firewall disabled — no rule needed',
            }
        }
        const rules = await sshCapture(
            plan.target,
            `pvesh get /nodes/$(hostname)/firewall/rules --output-format json 2>/dev/null`
        )
        return rules.stdout.includes('cofoundry build network')
            ? { done: true, note: 'host firewall rule already present' }
            : { done: false, note: 'Proxmox firewall on — opening build net' }
    },
    apply: async plan => {
        await remoteStreaming(
            plan.target,
            `pvesh create /nodes/$(hostname)/firewall/rules --action ACCEPT --type in --source ${BUILD_NET_CIDR} --enable 1 --comment ${shellQuote(BUILD_NET_FW_COMMENT)}`
        )
        return { note: `allowed ${BUILD_NET_CIDR} in (host firewall rule)` }
    },
}

export const stepDnsmasq: BootstrapStep = {
    id: 'dnsmasq',
    label: 'install dnsmasq',
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
export const stepDnsmasqConf: BootstrapStep = {
    id: 'dnsmasq-conf',
    label: 'write /etc/dnsmasq.d/vmbr1-nat.conf',
    probe: async plan => {
        const [existing, otherConfig] = await Promise.all([
            sshCapture(
                plan.target,
                `cat ${shellQuote(DNSMASQ_CONF_PATH)} 2>/dev/null`
            ),
            sshCapture(plan.target, activeDnsmasqConfigCmd),
        ])
        const wanted = dnsmasqConf(plan.buildDns, otherConfig.stdout)
        if (existing.ok && existing.stdout.trim() === wanted.trim()) {
            return (await sshOk(
                plan.target,
                'systemctl is-active --quiet dnsmasq && dnsmasq --test >/dev/null 2>&1'
            ))
                ? { done: true, note: 'managed config is active and valid' }
                : { done: false, note: 'managed config needs activation' }
        }
        if (
            existing.ok &&
            !(
                existing.stdout.includes('# Managed by Cofoundry.') ||
                (existing.stdout.includes('interface=vmbr1') &&
                    existing.stdout.includes(
                        `dhcp-range=${BUILD_DHCP_RANGE_START},${BUILD_DHCP_RANGE_END}`
                    ))
            )
        ) {
            throw new Error(
                `${DNSMASQ_CONF_PATH} exists but is not recognizable as a Cofoundry build-network config`
            )
        }
        return {
            done: false,
            note: existing.ok ? 'managed config needs update' : undefined,
        }
    },
    apply: async plan => {
        // Hosts dir must exist before dnsmasq starts or it errors out.
        // Also sweep any legacy /etc/dnsmasq.d/cofoundry-slot-*.conf snippets
        // from the pre-dhcp-hostsfile layout so they don't linger as stale
        // static reservations.
        await remoteStreaming(
            plan.target,
            `mkdir -p ${DNSMASQ_HOSTS_DIR} && rm -f /etc/dnsmasq.d/cofoundry-slot-*.conf`
        )
        const otherConfig = await sshCapture(
            plan.target,
            activeDnsmasqConfigCmd
        )
        const candidate = `${DNSMASQ_CONF_PATH}.cofoundry-new`
        await writeRemoteFile(
            plan.target,
            candidate,
            dnsmasqConf(plan.buildDns, otherConfig.stdout)
        )
        await remoteStreaming(
            plan.target,
            `set -e
target=${shellQuote(DNSMASQ_CONF_PATH)}
candidate=${shellQuote(candidate)}
backup="${DNSMASQ_CONF_PATH}.cofoundry-backup.$$"
had_existing=0
if [ -e "$target" ]; then
    cp -a "$target" "$backup"
    had_existing=1
fi
mv "$candidate" "$target"
rollback() {
    if [ "$had_existing" -eq 1 ]; then mv "$backup" "$target"; else rm -f "$target"; fi
}
if ! dnsmasq --test; then
    rollback
    echo 'candidate dnsmasq configuration failed validation; restored previous configuration' >&2
    exit 1
fi
if ! systemctl restart dnsmasq; then
    rollback
    systemctl restart dnsmasq >/dev/null 2>&1 || true
    echo 'dnsmasq restart failed; restored previous configuration' >&2
    exit 1
fi
rm -f "$backup"`
        )
        return { note: 'validated, written, and dnsmasq restarted' }
    },
}

export const stepNetslotDir: BootstrapStep = {
    id: 'netslot-dir',
    label: 'create /var/lib/cofoundry for netslot lock',
    probe: async plan =>
        (await sshOk(plan.target, '[ -d /var/lib/cofoundry ]'))
            ? { done: true, note: 'already exists' }
            : { done: false },
    apply: async plan => {
        await remoteStreaming(plan.target, 'mkdir -p /var/lib/cofoundry')
        return { note: 'created' }
    },
}
