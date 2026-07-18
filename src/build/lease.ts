import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { Env } from '@/env.ts'
import type { RecipeInfo } from '@/config.ts'
import { captureRemote, registerCleanup } from '@/build/remote.ts'
import { shellQuote } from '@/util.ts'

export const RUN_LEASE_DIR = '/var/lib/cofoundry/run-leases'
export const RUN_LEASE_LOCK = '/var/lib/cofoundry/run-leases.lock'
export const RUN_LEASE_STALE_SECS = 10 * 60

const HEARTBEAT_MS = 60_000
const RETRY_MS = 10_000

export type RunLease = {
    id: string
    setVmid: (vmid: number) => Promise<void>
    release: () => Promise<void>
}

type LeaseRequest = {
    id: string
    kind: 'build' | 'verify'
    recipe: RecipeInfo
    remoteTmpDir: string
    preserveVm: boolean
    storage: string
}

const leasePath = (id: string): string => `${RUN_LEASE_DIR}/${id}`

const leaseRecord = (request: LeaseRequest, vmid: number): string =>
    [
        request.kind,
        request.recipe.name,
        vmid,
        request.recipe.buildMemoryMb ?? 0,
        request.recipe.buildCores ?? 0,
        request.remoteTmpDir,
        request.preserveVm ? 1 : 0,
        request.storage,
    ].join('\t')

/**
 * Shell shared by admission and prune. A stale lease means its runner stopped
 * heartbeating; reap only resources named by that lease, then remove it.
 */
export const sweepRunLeasesScript = (
    staleSeconds = RUN_LEASE_STALE_SECS
): string => `
now=$(date +%s)
for lease in ${shellQuote(RUN_LEASE_DIR)}/*; do
    [ -f "$lease" ] || continue
    modified=$(stat -c %Y "$lease" 2>/dev/null || echo "$now")
    [ "$((now - modified))" -gt ${staleSeconds} ] || continue
    IFS=$'\\t' read -r kind recipe vmid memory cores tmpdir preserve_vm storage < "$lease" || true
    echo "reaping stale cofoundry $kind lease \${lease##*/} ($recipe)" >&2
    if [ "$preserve_vm" != 1 ]; then
        case "$vmid" in
            ''|0|*[!0-9]*) ;;
            *)
                qm stop "$vmid" --skiplock 1 >/dev/null 2>&1 || true
                qm unlock "$vmid" >/dev/null 2>&1 || true
                qm destroy "$vmid" --purge 1 --destroy-unreferenced-disks 1 --skiplock 1 >/dev/null 2>&1 || true
                if ! qm config "$vmid" >/dev/null 2>&1 && [ -n "$storage" ]; then
                    pvesm list "$storage" --content images 2>/dev/null | awk -v id="$vmid" 'NR>1 && $NF==id {print $1}' | while IFS= read -r volid; do
                        pvesm free "$volid" >/dev/null 2>&1 || true
                    done
                fi
                ;;
        esac
    fi
    case "$tmpdir" in
        */cofoundry-tmp/build-*)
            pkill -9 -f -- "$tmpdir" >/dev/null 2>&1 || true
            rm -rf -- "$tmpdir"
            ;;
        */cofoundry-verify-*)
            pkill -9 -f -- "$tmpdir" >/dev/null 2>&1 || true
            owner=\${tmpdir##*cofoundry-verify-}
            rm -rf -- "$tmpdir"
            rm -f -- "/var/lib/cofoundry/verify-reservations/$owner"
            ;;
    esac
    rm -f -- "$lease"
done
`

export const buildLeaseAdmissionScript = (
    env: Pick<Env, 'CF_BUILD_MEMORY_BUDGET_MB' | 'CF_BUILD_CPU_BUDGET'>,
    request: LeaseRequest
): string => {
    const file = leasePath(request.id)
    const memory = request.recipe.buildMemoryMb ?? 0
    const cores = request.recipe.buildCores ?? 0
    const configuredMemory = env.CF_BUILD_MEMORY_BUDGET_MB
    const configuredCpu = env.CF_BUILD_CPU_BUDGET

    return `set -euo pipefail
mkdir -p ${shellQuote(RUN_LEASE_DIR)}
exec 9>${shellQuote(RUN_LEASE_LOCK)}
flock -x 9
${sweepRunLeasesScript()}
memory_capacity=$(awk '/MemTotal/ { print int($2 / 1024 * 0.8) }' /proc/meminfo)
cpu_capacity=$(nproc)
memory_budget=${configuredMemory ?? '$memory_capacity'}
cpu_budget=${configuredCpu ?? '$cpu_capacity'}
[ "$memory_budget" -le "$memory_capacity" ] || memory_budget=$memory_capacity
[ "$cpu_budget" -le "$cpu_capacity" ] || cpu_budget=$cpu_capacity
memory_used=0
cpu_used=0
same_recipe=0
for lease in ${shellQuote(RUN_LEASE_DIR)}/*; do
    [ -f "$lease" ] || continue
    IFS=$'\\t' read -r _kind active_recipe _vmid active_memory active_cores _tmp < "$lease" || continue
    memory_used=$((memory_used + active_memory))
    cpu_used=$((cpu_used + active_cores))
    [ "$active_recipe" = ${shellQuote(request.recipe.name)} ] && same_recipe=1
done
if [ ${memory} -gt "$memory_budget" ] || [ ${cores} -gt "$cpu_budget" ]; then
    echo "REJECT $memory_budget $cpu_budget"
elif [ "$same_recipe" -eq 1 ] || [ $((memory_used + ${memory})) -gt "$memory_budget" ] || [ $((cpu_used + ${cores})) -gt "$cpu_budget" ]; then
    echo "WAIT $memory_used $memory_budget $cpu_used $cpu_budget $same_recipe"
else
    tmp=${shellQuote(`${file}.tmp`)}.$$
    trap 'rm -f "$tmp"' EXIT
    printf '%s\\n' ${shellQuote(leaseRecord(request, 0))} > "$tmp"
    chmod 600 "$tmp"
    mv -f "$tmp" ${shellQuote(file)}
    trap - EXIT
    echo "ACQUIRED $memory_budget $cpu_budget"
fi
`
}

const updateLeaseVmidScript = (request: LeaseRequest, vmid: number): string => {
    const file = leasePath(request.id)
    return `set -euo pipefail
exec 9>${shellQuote(RUN_LEASE_LOCK)}
flock -x 9
test -f ${shellQuote(file)}
tmp=${shellQuote(`${file}.tmp`)}.$$
trap 'rm -f "$tmp"' EXIT
printf '%s\\n' ${shellQuote(leaseRecord(request, vmid))} > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" ${shellQuote(file)}
trap - EXIT
`
}

const wait = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms))

export const acquireRunLease = async (
    env: Env,
    kind: LeaseRequest['kind'],
    recipe: RecipeInfo,
    remoteTmpDir: string,
    options: {
        preserveVm?: boolean
        onWait?: (message: string) => void
    } = {}
): Promise<RunLease> => {
    if (
        !recipe.buildMemoryMb ||
        !recipe.buildCores ||
        recipe.buildMemoryMb < 1 ||
        recipe.buildCores < 1
    ) {
        throw new Error(
            `${recipe.name} must declare static memory and cores for node-wide admission`
        )
    }
    const request: LeaseRequest = {
        id: randomUUID(),
        kind,
        recipe,
        remoteTmpDir,
        preserveVm: Boolean(options.preserveVm),
        storage: env.CF_STORAGE,
    }
    const file = leasePath(request.id)

    while (true) {
        const output = (
            await captureRemote(
                env.SSH_TARGET,
                `bash -s <<'__CF_LEASE__'\n${buildLeaseAdmissionScript(env, request)}\n__CF_LEASE__`
            )
        ).trim()
        const [status, ...values] = output.split(/\s+/)
        if (status === 'ACQUIRED') break
        if (status === 'REJECT') {
            throw new Error(
                `${recipe.name} requires ${recipe.buildMemoryMb ?? 0} MiB/${recipe.buildCores ?? 0} CPU, exceeding the node build budget ${values[0]} MiB/${values[1]} CPU`
            )
        }
        if (status !== 'WAIT')
            throw new Error(`invalid build-lease response: ${output}`)
        options.onWait?.(
            values[4] === '1'
                ? `waiting for another ${recipe.name} run`
                : `waiting for node capacity (${values[0]}/${values[1]} MiB, ${values[2]}/${values[3]} CPU in use)`
        )
        await wait(RETRY_MS)
    }

    let released = false
    const removeCommand = `rm -f -- ${shellQuote(file)}`
    const signalCleanupCommand =
        `exec 9>${shellQuote(RUN_LEASE_LOCK)}; flock -x 9; ` +
        `if [ -f ${shellQuote(file)} ]; then ` +
        `IFS=$'\\t' read -r _kind _recipe vmid _memory _cores tmpdir preserve_vm storage < ${shellQuote(file)} || true; ` +
        `pkill -9 -f -- "$tmpdir" >/dev/null 2>&1 || true; ` +
        `if [ "$preserve_vm" != 1 ]; then case "$vmid" in ''|0|*[!0-9]*) ;; *) ` +
        `qm stop "$vmid" --skiplock 1 >/dev/null 2>&1 || true; qm unlock "$vmid" >/dev/null 2>&1 || true; ` +
        `qm destroy "$vmid" --purge 1 --destroy-unreferenced-disks 1 --skiplock 1 >/dev/null 2>&1 || true; ` +
        `if ! qm config "$vmid" >/dev/null 2>&1 && [ -n "$storage" ]; then pvesm list "$storage" --content images 2>/dev/null | ` +
        `awk -v id="$vmid" 'NR>1 && $NF==id {print $1}' | while IFS= read -r volid; do pvesm free "$volid" >/dev/null 2>&1 || true; done; fi ;; esac; fi; ` +
        `case "$tmpdir" in */cofoundry-tmp/build-*|*/cofoundry-verify-*) rm -rf -- "$tmpdir" ;; esac; ` +
        `${removeCommand}; fi`
    const unregister = registerCleanup(() => {
        if (released) return
        spawnSync('ssh', [env.SSH_TARGET, signalCleanupCommand], {
            stdio: 'ignore',
        })
    })
    const heartbeat = setInterval(() => {
        void captureRemote(
            env.SSH_TARGET,
            `test ! -f ${shellQuote(file)} || touch ${shellQuote(file)}`
        ).catch(() => {})
    }, HEARTBEAT_MS)
    heartbeat.unref()

    return {
        id: request.id,
        setVmid: async vmid => {
            await captureRemote(
                env.SSH_TARGET,
                `bash -s <<'__CF_LEASE_VMID__'\n${updateLeaseVmidScript(request, vmid)}\n__CF_LEASE_VMID__`
            )
        },
        release: async () => {
            if (released) return
            released = true
            clearInterval(heartbeat)
            unregister()
            await captureRemote(env.SSH_TARGET, removeCommand).catch(() => {})
        },
    }
}
