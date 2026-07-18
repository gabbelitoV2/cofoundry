import { redactSensitive } from '@/util.ts'

// A command to run inside the guest via the QEMU guest agent (`qm guest exec`).
// The agent is only up once the OS/tools are running, so these are best-effort:
// early-install / WinPE / never-booted failures capture nothing here and the
// screenshots carry the diagnosis instead.
export type GuestLogSpec = { name: string; argv: string[] }

// Output is byte-capped so a huge log can't blow the guest agent's limit. A glob
// that matches nothing passes through literally and tail simply reports empty.
const linuxTail = (name: string, path: string): GuestLogSpec => ({
    name,
    argv: ['/bin/sh', '-c', `tail -c 200000 ${path} 2>/dev/null`],
})

const winTail = (name: string, path: string): GuestLogSpec => ({
    name,
    argv: [
        'powershell',
        '-Command',
        `Get-Content ${path} -Tail 2000 -ErrorAction SilentlyContinue`,
    ],
})

const journal: GuestLogSpec = {
    name: 'journal',
    argv: [
        '/bin/sh',
        '-c',
        'journalctl -b --no-pager 2>/dev/null | tail -c 200000',
    ],
}

const cloudInit: GuestLogSpec[] = [
    linuxTail('cloud-init', '/var/log/cloud-init.log'),
    linuxTail('cloud-init-output', '/var/log/cloud-init-output.log'),
]

// Ubuntu autoinstall: the subiquity server debug log is the installer's area.
export const ubuntuGuestLogs: GuestLogSpec[] = [
    ...cloudInit,
    linuxTail('subiquity', '/var/log/installer/subiquity-server-debug.log'),
    journal,
]

// Debian preseed: debian-installer logs to syslog during install; the target
// retains a copy under /var/log/installer.
export const debianGuestLogs: GuestLogSpec[] = [
    linuxTail('syslog', '/var/log/syslog'),
    linuxTail('installer-syslog', '/var/log/installer/syslog'),
    ...cloudInit,
    journal,
]

// AlmaLinux / Rocky (kickstart): anaconda's logs are the installer's area;
// ks-script logs surface %post failures.
export const rhelGuestLogs: GuestLogSpec[] = [
    linuxTail('anaconda', '/var/log/anaconda/anaconda.log'),
    linuxTail('anaconda-program', '/var/log/anaconda/program.log'),
    linuxTail('anaconda-storage', '/var/log/anaconda/storage.log'),
    linuxTail('anaconda-ks-script', '/var/log/anaconda/ks-script*.log'),
    journal,
]

// Windows: the Panther setup logs (the recipe's "logging area") plus a CBS
// servicing tail — where update/finalize failures show up, and where the guest
// agent is actually running, so these populate.
export const windowsGuestLogs: GuestLogSpec[] = [
    winTail('panther-setupact', 'C:\\Windows\\Panther\\setupact.log'),
    winTail('panther-setuperr', 'C:\\Windows\\Panther\\setuperr.log'),
    winTail(
        'panther-unattendgc',
        'C:\\Windows\\Panther\\UnattendGC\\setupact.log'
    ),
    winTail('cbs', 'C:\\Windows\\Logs\\CBS\\CBS.log'),
]

// Fallback for an unknown/blank group.
export const genericLinuxGuestLogs: GuestLogSpec[] = [...cloudInit, journal]

// Pick the in-guest log set for a recipe's family, keyed on its `# group:`
// header (src/config.ts) — a new recipe in an existing family inherits the
// right paths automatically.
export const guestLogSpecs = (group?: string): GuestLogSpec[] => {
    switch (group) {
        case 'windows-server':
            return windowsGuestLogs
        case 'ubuntu':
            return ubuntuGuestLogs
        case 'debian':
            return debianGuestLogs
        case 'almalinux':
        case 'rocky-linux':
            return rhelGuestLogs
        default:
            return genericLinuxGuestLogs
    }
}

/**
 * `qm guest exec --output-format json` returns `{ "out-data": "<decoded text>" }`
 * (Proxmox already base64-decodes the agent payload). Pull that field and scrub
 * registered secrets — Panther logs are documented to echo the unattend password
 * verbatim, so this is the safety net before anything lands on disk. Non-JSON
 * agent errors fall through as raw text (still scrubbed).
 */
export const parseGuestExecOutput = (raw: string): string => {
    let text = raw
    try {
        const parsed = JSON.parse(raw) as { 'out-data'?: string }
        if (typeof parsed['out-data'] === 'string') text = parsed['out-data']
    } catch {
        // keep raw
    }
    return redactSensitive(text.trim())
}
