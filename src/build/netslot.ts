import { captureRemote, registerCleanup } from '@/build/remote.ts'
import { spawnSync } from 'node:child_process'
import type { Env } from '@/env.ts'
import { shellQuote } from '@/util.ts'
import {
    BUILD_NET_GATEWAY,
    BUILD_NET_PREFIX,
    BUILD_SLOT_BASE,
    BUILD_SLOT_COUNT,
} from '@/build/buildnet.ts'

// Per-build network slot allocated on the node's NAT bridge (vmbr1, 10.0.0.0/24).
// Each slot owns one IP + a deterministic MAC, registered with dnsmasq as a
// static DHCP reservation so Packer can address the build VM up-front (no IP
// discovery, no race with the qemu-guest-agent). Multiple slots are independent,
// so builds can run in parallel on a single node.
//
// Layout:
//   IP  = 10.0.0.<100 + slotIndex>     for slotIndex in [0, BUILD_SLOT_COUNT)
//   MAC = 02:50:4B:00:00:<slot byte>
//   Reservation file: /etc/dnsmasq.d/cofoundry-hosts.d/slot-<NN>
//
// Reservations live in a dhcp-hostsfile= directory (configured by bootstrap)
// because `dhcp-host=` lines in regular /etc/dnsmasq.d/*.conf files are only
// parsed at dnsmasq startup — SIGHUP does not re-read them, so adding a
// reservation at build time would silently fall through to the dynamic pool.
// Files in a dhcp-hostsfile dir are re-read on SIGHUP.
//
// Free-slot discovery is `flock`-serialised on the node so concurrent
// `cf build` invocations can't pick the same slot.
//
// Orphan reclaim: a build killed by anything other than a clean exit or SIGINT
// (SIGTERM/SIGKILL, OOM, host reboot, power loss) leaves its snippet behind,
// silently leaking a slot forever. So allocation first reconciles: any snippet
// with no live DHCP lease for its IP, whose file is older than
// STALE_RECLAIM_SECS, belongs to a build that's long gone and is swept. A live
// build always holds a non-expired lease (12h lease time, far longer than any
// build), and the age guard keeps us from racing a just-allocated slot whose VM
// hasn't booted and DHCP'd yet.

const LOCK_DIR = '/var/lib/cofoundry'
const LOCK_FILE = `${LOCK_DIR}/netslot.lock`
const SNIPPET_DIR = '/etc/dnsmasq.d/cofoundry-hosts.d'
const SNIPPET_PREFIX = 'slot-'
const LEASES_FILE = '/var/lib/misc/dnsmasq.leases'

// A snippet with no active lease is only reclaimed once it's older than this —
// comfortably longer than the worst-case gap between allocating a slot and the
// build VM acquiring its DHCP lease (slow Windows PE boot is still minutes).
const STALE_RECLAIM_SECS = 1800

export type BuildSlot = {
    ip: string
    gw: string
    mac: string
    slotIndex: number
    release: () => Promise<void>
}

const slotIp = (slotIndex: number): string =>
    `${BUILD_NET_PREFIX}.${BUILD_SLOT_BASE + slotIndex}`

const slotMac = (slotIndex: number): string => {
    const byte = (BUILD_SLOT_BASE + slotIndex).toString(16).padStart(2, '0')
    return `02:50:4B:00:00:${byte}`
}

const snippetPath = (slotIndex: number): string =>
    `${SNIPPET_DIR}/${SNIPPET_PREFIX}${String(slotIndex).padStart(2, '0')}`

// Reload dnsmasq atomically — SIGHUP makes it re-read /etc/dnsmasq.d/* and
// honour new static reservations without disturbing in-flight leases held by
// other concurrent builds. We fall back to `systemctl reload` if pkill fails
// (e.g. dnsmasq supervised differently).
const reloadDnsmasqCmd = `(pkill -HUP -x dnsmasq 2>/dev/null || systemctl reload dnsmasq 2>/dev/null || systemctl restart dnsmasq) && sleep 0.2`

export const allocateBuildSlot = async (env: Env): Promise<BuildSlot> => {
    // One atomic shell pass: take the lock, scan existing snippets, pick the
    // first free index, write the new snippet, reload dnsmasq, print the index.
    const script = `
set -e
mkdir -p ${shellQuote(LOCK_DIR)} ${shellQuote(SNIPPET_DIR)}
exec 9>${shellQuote(LOCK_FILE)}
flock 9
now=$(date +%s)
# Reclaim orphaned snippets: no live (non-expired) lease for the reserved IP and
# the file is older than the boot/DHCP grace window, so the owning build is gone.
for f in ${shellQuote(SNIPPET_DIR)}/${SNIPPET_PREFIX}*; do
    [ -e "$f" ] || continue
    sip=$(cut -d, -f2 "$f")
    active=0
    if [ -f ${shellQuote(LEASES_FILE)} ] && awk -v ip="$sip" -v now="$now" \\
        '$3==ip && ($1+0==0 || $1+0>now){f=1} END{exit !f}' ${shellQuote(LEASES_FILE)}; then
        active=1
    fi
    mt=$(stat -c %Y "$f" 2>/dev/null || echo "$now")
    if [ "$active" -eq 0 ] && [ "$(( now - mt ))" -gt ${STALE_RECLAIM_SECS} ]; then
        echo "reclaiming stale netslot \${f##*/} ($sip): no lease, age $(( now - mt ))s" >&2
        rm -f "$f"
    fi
done
used=" "
for f in ${shellQuote(SNIPPET_DIR)}/${SNIPPET_PREFIX}*; do
    [ -e "$f" ] || continue
    base=\${f##*/}
    n=\${base#${SNIPPET_PREFIX}}
    used="$used$n "
done
pick=""
i=0
while [ "$i" -lt ${BUILD_SLOT_COUNT} ]; do
    pad=$(printf '%02d' "$i")
    case "$used" in
        *" $pad "*) ;;
        *) pick="$i"; break ;;
    esac
    i=$((i + 1))
done
if [ -z "$pick" ]; then
    echo "no free slot (all ${BUILD_SLOT_COUNT} reservations in use)" >&2
    exit 1
fi
pad=$(printf '%02d' "$pick")
ip="${BUILD_NET_PREFIX}.$(( ${BUILD_SLOT_BASE} + pick ))"
byte=$(printf '%02x' "$(( ${BUILD_SLOT_BASE} + pick ))")
mac="02:50:4b:00:00:$byte"
# Evict any VM squatting this slot's MAC. A slot is exclusive, so the only VM
# that can carry this deterministic MAC is an orphan from a previous build of the
# same slot whose VM outlived a dirty teardown (SIGKILL/OOM/CI-cancel killed the
# launcher before its VM-destroy ran, or its snippet was released first leaving
# the VM unmarked). Left alive, it answers ARP for the slot IP and the new build
# VM's traffic blackholes — Packer then waits out its full SSH/WinRM timeout.
# qm config stores the MAC upper-cased, so match case-insensitively.
for cf in /etc/pve/qemu-server/*.conf; do
    [ -e "$cf" ] || continue
    grep -iqF "$mac" "$cf" || continue
    vid=\${cf##*/}; vid=\${vid%.conf}
    echo "evicting orphan VM $vid squatting netslot $pad ($ip)" >&2
    qm stop "$vid" --skiplock 1 >/dev/null 2>&1 || true
    qm destroy "$vid" --purge 1 --destroy-unreferenced-disks 1 --skiplock 1 >/dev/null 2>&1 || true
done
printf '%s,%s\\n' "$mac" "$ip" > ${shellQuote(SNIPPET_DIR)}/${SNIPPET_PREFIX}"$pad"
# Purge any stale lease holding the reserved IP or matching the reserved MAC,
# so a previous build's lease can't squat on the slot. dnsmasq re-reads the
# leases file on SIGHUP.
if [ -f ${shellQuote(LEASES_FILE)} ]; then
    awk -v ip="$ip" -v mac="$mac" '$2 != mac && $3 != ip' ${shellQuote(LEASES_FILE)} > ${shellQuote(LEASES_FILE)}.tmp && mv ${shellQuote(LEASES_FILE)}.tmp ${shellQuote(LEASES_FILE)}
fi
${reloadDnsmasqCmd}
echo "$pick"
`
    const out = await captureRemote(
        env.SSH_TARGET,
        `bash -s <<'__CF_NETSLOT__'\n${script}\n__CF_NETSLOT__`
    )
    const slotIndex = Number.parseInt(out.trim(), 10)
    if (
        !Number.isFinite(slotIndex) ||
        slotIndex < 0 ||
        slotIndex >= BUILD_SLOT_COUNT
    ) {
        throw new Error(`netslot allocator returned invalid index: ${out}`)
    }

    const ip = slotIp(slotIndex)
    const mac = slotMac(slotIndex)
    const snippet = snippetPath(slotIndex)

    let released = false
    const releaseScript = `rm -f ${shellQuote(snippet)} && ${reloadDnsmasqCmd}`

    // Synchronous SIGINT cleanup: best-effort delete the snippet over ssh.
    const unregister = registerCleanup(() => {
        if (released) return
        process.stderr.write(
            `\ncancelled — releasing netslot ${slotIndex} (${ip})\n`
        )
        spawnSync('ssh', [env.SSH_TARGET, releaseScript], { stdio: 'ignore' })
    })

    const release = async (): Promise<void> => {
        if (released) return
        released = true
        unregister()
        await captureRemote(env.SSH_TARGET, releaseScript).catch(() => {})
    }

    return { ip, gw: BUILD_NET_GATEWAY, mac, slotIndex, release }
}
