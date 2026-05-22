import { createInterface } from 'node:readline'
import pc from 'picocolors'
import type { Registry, Group, Template } from '../../src/registry/schema.ts'
import type { VmidAssignment } from './vmid.ts'

const rl = (): ReturnType<typeof createInterface> =>
    createInterface({ input: process.stdin, output: process.stdout })

const question = (prompt: string): Promise<string> =>
    new Promise(resolve => {
        const iface = rl()
        iface.question(prompt, answer => {
            iface.close()
            resolve(answer.trim())
        })
    })

export const promptStorage = async (defaultStorage?: string): Promise<string> => {
    if (defaultStorage) return defaultStorage
    const answer = await question(pc.bold('Proxmox storage volume: '))
    if (!answer) throw new Error('Storage volume is required.')
    return answer
}

export const promptTemplateSelection = async (
    registry: Registry,
    groupFilter?: string,
    tagFilter?: string
): Promise<Template[]> => {
    const groups = groupFilter
        ? registry.groups.filter(g => g.id === groupFilter)
        : registry.groups

    const entries: { group: Group; template: Template; index: number }[] = []
    let i = 0
    for (const group of groups) {
        for (const t of group.templates) {
            if (tagFilter && !t.tags?.includes(tagFilter)) continue
            entries.push({ group, template: t, index: ++i })
        }
    }

    if (entries.length === 0) {
        throw new Error('No templates match the given filters.')
    }

    console.log()
    let currentGroupId = ''
    for (const { group, template, index } of entries) {
        if (group.id !== currentGroupId) {
            currentGroupId = group.id
            console.log(pc.bold(pc.cyan(`\n  ${group.display_name}`)))
            if (group.description) console.log(`  ${pc.dim(group.description)}`)
        }
        console.log(`  ${pc.dim(`[${index}]`)} ${template.display}  ${pc.dim(template.arch)}`)
    }
    console.log()

    const answer = await question(pc.bold('Select templates (e.g. 1,3-5 or "all"): '))
    const selected = parseSelection(answer, entries.length)
    return selected.map(idx => entries[idx - 1]!.template)
}

const parseSelection = (input: string, max: number): number[] => {
    if (input.toLowerCase() === 'all') {
        return Array.from({ length: max }, (_, i) => i + 1)
    }
    const indices = new Set<number>()
    for (const part of input.split(',')) {
        const range = part.trim().match(/^(\d+)(?:-(\d+))?$/)
        if (!range) throw new Error(`Invalid selection: "${part.trim()}"`)
        const start = Number(range[1])
        const end = range[2] ? Number(range[2]) : start
        for (let n = start; n <= end; n++) {
            if (n < 1 || n > max) throw new Error(`Index out of range: ${n}`)
            indices.add(n)
        }
    }
    return [...indices].sort((a, b) => a - b)
}

export const confirmVmidConflicts = async (assignments: VmidAssignment[]): Promise<boolean> => {
    const conflicts = assignments.filter(a => a.conflict)
    if (conflicts.length === 0) return true

    console.log()
    console.log(pc.yellow(pc.bold('VMID conflicts:')))
    for (const a of assignments) {
        const suggested = a.template.suggested_vmid
        if (a.conflict) {
            console.log(
                `  ${a.template.name.padEnd(32)} → ${pc.bold(String(a.vmid))}  ${pc.dim(`(suggested ${suggested ?? 'none'}, taken)`)}`
            )
        } else {
            console.log(
                `  ${a.template.name.padEnd(32)} → ${pc.bold(String(a.vmid))}  ${pc.dim('(free)')}`
            )
        }
    }
    console.log()

    const answer = await question('Proceed? [Y/n] ')
    return answer === '' || answer.toLowerCase() === 'y'
}
