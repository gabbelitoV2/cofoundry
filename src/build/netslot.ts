import { captureRemote, registerCleanup } from './remote.ts'
import { spawnSync } from 'node:child_process'
import type { Env } from '../env.ts'
import { shellQuote } from '../util.ts'

// Per-build network slot allocated on the node's NAT bridge (vmbr1, 10.0.0.0/24).
// Each slot owns one IP + a deterministic MAC, registered with dnsmasq as a
// static DHCP reservation so Packer can address the build VM up-front (no IP
// discovery, no race with the qemu-guest-agent). Multiple slots are independent,
// so builds can run in parallel on a single node.
//
// Layout:
//   IP  = 10.0.0.<100 + slotIndex>     for slotIndex in [0, SLOT_COUNT)
//   MAC = 02:50:4B:00:00:<slot byte>
//   Reservation file: /etc/dnsmasq.d/cofoundry-slot-<NN>.conf
//
// Free-slot discovery is `flock`-serialised on the node so concurrent
// `cf build` invocations can't pick the same slot.

const SUBNET_PREFIX = '10.0.0'
const SLOT_BASE = 100
const SLOT_COUNT = 50
export const BUILD_BRIDGE_GATEWAY = `${SUBNET_PREFIX}.1`
const LOCK_DIR = '/var/lib/cofoundry'
const LOCK_FILE = `${LOCK_DIR}/netslot.lock`
const SNIPPET_DIR = '/etc/dnsmasq.d'
const SNIPPET_PREFIX = 'cofoundry-slot-'

export type BuildSlot = {
    ip: string
    gw: string
    mac: string
    slotIndex: number
    release: () => Promise<void>
}

const slotIp = (slotIndex: number): string =>
    `${SUBNET_PREFIX}.${SLOT_BASE + slotIndex}`

const slotMac = (slotIndex: number): string => {
    const byte = (SLOT_BASE + slotIndex).toString(16).padStart(2, '0')
    return `02:50:4B:00:00:${byte}`
}

const snippetPath = (slotIndex: number): string =>
    `${SNIPPET_DIR}/${SNIPPET_PREFIX}${String(slotIndex).padStart(2, '0')}.conf`

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
mkdir -p ${shellQuote(LOCK_DIR)}
exec 9>${shellQuote(LOCK_FILE)}
flock 9
used=" "
for f in ${shellQuote(SNIPPET_DIR)}/${SNIPPET_PREFIX}*.conf; do
    [ -e "$f" ] || continue
    base=\${f##*/}
    n=\${base#${SNIPPET_PREFIX}}
    n=\${n%.conf}
    used="$used$n "
done
pick=""
i=0
while [ "$i" -lt ${SLOT_COUNT} ]; do
    pad=$(printf '%02d' "$i")
    case "$used" in
        *" $pad "*) ;;
        *) pick="$i"; break ;;
    esac
    i=$((i + 1))
done
if [ -z "$pick" ]; then
    echo "no free slot (all ${SLOT_COUNT} reservations in use)" >&2
    exit 1
fi
pad=$(printf '%02d' "$pick")
ip="${SUBNET_PREFIX}.$(( ${SLOT_BASE} + pick ))"
byte=$(printf '%02x' "$(( ${SLOT_BASE} + pick ))")
mac="02:50:4b:00:00:$byte"
printf 'dhcp-host=%s,%s\\n' "$mac" "$ip" > ${shellQuote(SNIPPET_DIR)}/${SNIPPET_PREFIX}"$pad".conf
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
        slotIndex >= SLOT_COUNT
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

    return { ip, gw: BUILD_BRIDGE_GATEWAY, mac, slotIndex, release }
}
