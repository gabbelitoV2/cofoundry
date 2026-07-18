import type { RecipeInfo } from '@/config.ts'

// Diagnostics live on a RAM-backed tmpfs (/run), never on VM storage
// (PVE_DUMP_DIR / /var/lib/vz). A runaway recorder therefore cannot fill the
// filesystem that holds guest disks and PVE state — the whole point of the
// "node side is the risky side" hardening. See docs/architecture.md.
export const DIAG_TMPFS_BASE = '/run/cofoundry-diag'

/** Per-build recorder dir on the node, keyed by the live VMID. */
export const diagnosticsRemoteDir = (vmid: number): string =>
    `${DIAG_TMPFS_BASE}/${vmid}`

/** Local per-run dir name: `<recipe>-<arch>-<YYYYMMDD-HHMMSS>`. */
export const diagnosticsRunDirName = (recipe: RecipeInfo, now: Date): string => {
    const pad = (n: number): string => String(n).padStart(2, '0')
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    return `${recipe.name}-${recipe.arch}-${date}-${time}`
}
