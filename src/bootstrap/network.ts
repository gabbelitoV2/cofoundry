import { execa } from 'execa'
import { remoteStreaming } from '@/build/remote.ts'
import {
    BUILD_DHCP_RANGE_END,
    BUILD_DHCP_RANGE_START,
    BUILD_NET_BRIDGE_ADDR,
    BUILD_NET_CIDR,
    BUILD_NET_GATEWAY,
} from '@/build/buildnet.ts'
import { shellQuote } from '@/util.ts'
import type { BootstrapStep } from '@/bootstrap/model.ts'
import { sshCapture, sshOk, writeRemoteFile } from '@/bootstrap/remote.ts'

const APT_INSTALL = 'DEBIAN_FRONTEND=noninteractive apt-get install -y'

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

export const stepVmbr1: BootstrapStep = {
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
    inScope: plan => plan.needBuildNet,
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
dhcp-range=${BUILD_DHCP_RANGE_START},${BUILD_DHCP_RANGE_END},12h
dhcp-option=3,${BUILD_NET_GATEWAY}
dhcp-option=6,8.8.8.8
dhcp-option=option:router,${BUILD_NET_GATEWAY}
dhcp-hostsfile=${DNSMASQ_HOSTS_DIR}
`

export const stepDnsmasqConf: BootstrapStep = {
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

export const stepNetslotDir: BootstrapStep = {
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
