import { log } from '@/log.ts'
import type { Sidecar, UploadSource } from '@/upload/model.ts'
import { recipeNameFromSidecar } from '@/upload/template.ts'

export type LoadedSidecar = { sidecar: Sidecar; file: string }

export const loadSidecars = async (
    source: UploadSource,
    names?: string[]
): Promise<LoadedSidecar[]> => {
    const loaded = await Promise.all(
        (await source.listJsons()).map(async file => {
            try {
                const sidecar = JSON.parse(
                    await source.readJson(file)
                ) as Sidecar
                return { sidecar, file }
            } catch (error) {
                log.warn(
                    `skipping ${file}: ${error instanceof Error ? error.message : String(error)}`
                )
                return null
            }
        })
    )
    const found = loaded.filter((item): item is LoadedSidecar => item !== null)
    if (!names || names.length === 0) return found
    const wanted = new Set(names)
    return found.filter(({ sidecar }) =>
        [sidecar.name, recipeNameFromSidecar(sidecar)].some(name =>
            wanted.has(name)
        )
    )
}
