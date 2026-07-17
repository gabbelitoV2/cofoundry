import type { BuildSlot } from '@/build/netslot.ts'

export const buildSlotVmid = (
    baseVmid: number,
    slot: BuildSlot | null
): number => (slot ? baseVmid * 100 + slot.slotIndex : baseVmid)

export const destroyVmCommand = (vmid: number): string =>
    `qm stop ${vmid} --skiplock 1 >/dev/null 2>&1 || true; ` +
    `qm unlock ${vmid} >/dev/null 2>&1 || true; ` +
    `qm destroy ${vmid} --purge 1 --destroy-unreferenced-disks 1 --skiplock 1 >/dev/null 2>&1 || true`
