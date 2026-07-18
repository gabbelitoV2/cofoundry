import type { BuildSlot } from '@/build/netslot.ts'
import { shellQuote } from '@/util.ts'

export const buildSlotVmid = (
    baseVmid: number,
    slot: BuildSlot | null
): number => (slot ? baseVmid * 100 + slot.slotIndex : baseVmid)

export const destroyVmCommand = (vmid: number, storage?: string): string =>
    `qm stop ${vmid} --skiplock 1 >/dev/null 2>&1 || true; ` +
    `qm unlock ${vmid} >/dev/null 2>&1 || true; ` +
    `qm destroy ${vmid} --purge 1 --destroy-unreferenced-disks 1 --skiplock 1 >/dev/null 2>&1 || true` +
    (storage
        ? `; if ! qm config ${vmid} >/dev/null 2>&1; then ` +
          `pvesm list ${shellQuote(storage)} --content images 2>/dev/null | ` +
          `awk -v vmid=${vmid} 'NR>1 && $NF==vmid {print $1}' | ` +
          `while IFS= read -r volid; do pvesm free "$volid" >/dev/null 2>&1 || true; done; fi`
        : '')
