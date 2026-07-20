import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { buildSlotAllocationScript } from '@/build/netslot.ts'

describe('buildSlotAllocationScript', () => {
    test('is valid Bash and derives addresses from the configured bridge', () => {
        const script = buildSlotAllocationScript({ CF_BUILD_BRIDGE: 'vmbr1' })
        const result = spawnSync('bash', ['-n'], {
            input: script,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
        expect(script).toContain("bridge='vmbr1'")
        expect(script).toContain('bridge_cidr=$(ip -4')
        expect(script).toContain('if fits_block 100')
        expect(script).toContain("'test-owner'")
        expect(script).toContain('/var/lib/cofoundry/netslots')
    })

    test('scans the cluster-wide config tree, not just the local node', () => {
        const script = buildSlotAllocationScript({ CF_BUILD_BRIDGE: 'vmbr1' })
        // Orphan discovery must see peers' VMs, reachable only under
        // /etc/pve/nodes/<node>/qemu-server (the bare /etc/pve/qemu-server
        // symlink covers the local node alone).
        expect(script).toContain('/etc/pve/nodes/*/qemu-server/*.conf')
        expect(script).not.toContain('for cf in /etc/pve/qemu-server/*.conf')
    })

    test('reclaims a stale slot only when no VM still holds its MAC', () => {
        const script = buildSlotAllocationScript({ CF_BUILD_BRIDGE: 'vmbr1' })
        // A static-IP build (Debian/Ubuntu preseed) never takes a DHCP lease, so
        // the running-VM guard is what keeps its slot from being reclaimed and
        // its VM evicted mid-build.
        expect(script).toContain('! slot_mac_running "$smac"')
    })

    test('evicts orphans on the node that owns them', () => {
        const script = buildSlotAllocationScript({ CF_BUILD_BRIDGE: 'vmbr1' })
        expect(script).toContain('qm_on_node "$node" "$vid" stop')
        expect(script).toContain('qm_on_node "$node" "$vid" destroy')
    })
})
