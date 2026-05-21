import { access } from 'node:fs/promises'
import type { Template } from '../../src/registry/schema.ts'

export async function vmidTaken(vmid: number): Promise<boolean> {
    const paths = [
        `/etc/pve/qemu-server/${vmid}.conf`,
        `/etc/pve/lxc/${vmid}.conf`,
    ]
    for (const p of paths) {
        try {
            await access(p)
            return true
        } catch {
            // not found — continue
        }
    }
    return false
}

export async function findFreeVmid(start: number, reserved: Set<number>): Promise<number> {
    let id = start
    while (reserved.has(id) || await vmidTaken(id)) {
        id++
    }
    return id
}

export interface VmidAssignment {
    template: Template
    vmid: number
    conflict: boolean
}

export async function resolveVmids(
    templates: Template[],
    vmidStart: number
): Promise<VmidAssignment[]> {
    const reserved = new Set<number>()
    const assignments: VmidAssignment[] = []

    for (const t of templates) {
        const suggested = t.suggested_vmid
        if (suggested && !reserved.has(suggested) && !(await vmidTaken(suggested))) {
            reserved.add(suggested)
            assignments.push({ template: t, vmid: suggested, conflict: false })
        } else {
            const free = await findFreeVmid(vmidStart, reserved)
            reserved.add(free)
            assignments.push({ template: t, vmid: free, conflict: true })
        }
    }

    return assignments
}
