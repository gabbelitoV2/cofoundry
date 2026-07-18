import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { ephemeralPackerIsoFind, orphanDiskFind } from '@/prune/node.ts'

const ISO_STORE = '/var/lib/vz/template/iso'

describe('ephemeralPackerIsoFind', () => {
    test('always sweeps answer ISOs and hash-named download-cache copies', () => {
        const cmd = ephemeralPackerIsoFind(ISO_STORE, { preserveVirtio: false })
        expect(cmd).toContain(`find ${ISO_STORE} -maxdepth 1`)
        expect(cmd).toContain("-name 'packer*.iso'")
        expect(cmd).toContain("-name 'packer*.iso.tmp'")
        expect(cmd).toContain('[0-9a-f]{40}')
    })

    test('preserveVirtio excludes the persistent virtio-win cache', () => {
        const cmd = ephemeralPackerIsoFind(ISO_STORE, { preserveVirtio: true })
        // The `! -name` exclusion must precede the match group so find ANDs it
        // against the pattern group rather than swallowing it into the OR.
        expect(cmd).toContain("! -name 'packer-virtio-win.iso'")
        expect(cmd.indexOf('! -name')).toBeLessThan(cmd.indexOf('\\('))
    })

    test('without preserveVirtio the virtio cache is not spared', () => {
        const cmd = ephemeralPackerIsoFind(ISO_STORE, { preserveVirtio: false })
        expect(cmd).not.toContain('! -name')
    })

    test('routine mode is age-gated and skips media referenced by a VM', () => {
        const cmd = ephemeralPackerIsoFind(ISO_STORE, {
            preserveVirtio: true,
            olderThanDays: 7,
            unreferencedOnly: true,
        })
        expect(cmd).toContain('-mtime +7')
        expect(cmd).toContain('/etc/pve/qemu-server')
        expect(cmd).toContain('grep -RqsF')
        const result = spawnSync('bash', ['-n'], {
            input: cmd,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
    })
})

describe('orphanDiskFind', () => {
    test('scopes the volume scan to the given storage pool', () => {
        const cmd = orphanDiskFind('local-zfs')
        expect(cmd).toContain(
            "pvesm list 'local-zfs' --content images 2>/dev/null"
        )
    })

    test('emits only volids whose owning VMID has no VM config', () => {
        const cmd = orphanDiskFind('local')
        // VMID is the last column ($NF), volid the first ($1); a volume is an
        // orphan only when `qm config <vmid>` fails.
        expect(cmd).toContain('print $NF"\\t"$1')
        expect(cmd).toContain(
            'qm config "$vmid" >/dev/null 2>&1 || echo "$volid"'
        )
    })

    test('shell-quotes the storage pool name', () => {
        expect(orphanDiskFind("a'b")).toContain("'a'\\''b'")
    })
})
