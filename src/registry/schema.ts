import { z } from 'zod'

export interface Template {
    name: string
    display: string
    arch: string
    sha256: string
    size: number
    min_disk_gb?: number
    url: string
    built_at: string
    suggested_vmid?: number
    tags?: string[]
    description?: string | null
}

export interface Group {
    id: string
    display_name: string
    description?: string | null
    templates: Template[]
}

export interface Registry {
    schema_version: '1'
    name: string
    description?: string | null
    author?: string
    homepage?: string
    generated_at: string
    groups: Group[]
}

export const TemplateSchema = z.object({
    name: z.string(),
    display: z.string(),
    arch: z.string(),
    sha256: z.string(),
    size: z.number(),
    min_disk_gb: z.number().optional(),
    url: z.string(),
    built_at: z.string(),
    suggested_vmid: z.number().optional(),
    tags: z.array(z.string()).optional(),
    description: z.string().nullable().optional(),
})

export const GroupSchema = z.object({
    id: z.string(),
    display_name: z.string(),
    description: z.string().nullable().optional(),
    templates: z.array(TemplateSchema),
})

export const RegistrySchema = z.object({
    schema_version: z.literal('1'),
    name: z.string(),
    description: z.string().nullable().optional(),
    author: z.string().optional(),
    homepage: z.string().optional(),
    generated_at: z.string(),
    groups: z.array(GroupSchema),
})
