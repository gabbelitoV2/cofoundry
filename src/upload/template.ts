import type { Sidecar } from '@/upload/model.ts'

export type UploadVariables = Record<
    'file' | 'recipe' | 'arch' | 'sha256' | 'group' | 'name' | 'filename',
    string
>

export const renderUploadTemplate = (
    template: string,
    variables: Record<string, string>
): string => {
    let output = template
    for (const [key, value] of Object.entries(variables))
        output = output.split(`{{${key}}}`).join(value)
    return output
}

export const recipeNameFromSidecar = (sidecar: Sidecar): string =>
    sidecar.name.endsWith(`-${sidecar.arch}`)
        ? sidecar.name.slice(0, -(sidecar.arch.length + 1))
        : sidecar.name

export const uploadVariables = (
    sidecar: Sidecar,
    file: string
): UploadVariables => {
    const recipe = recipeNameFromSidecar(sidecar)
    return {
        file,
        recipe,
        arch: sidecar.arch,
        sha256: sidecar.sha256,
        group: sidecar.group,
        name: recipe,
        filename: `${sidecar.name}-${sidecar.sha256}.vma.zst`,
    }
}

export const formatArtifactSize = (bytes: number): string => {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)}GB`
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)}MB`
    return `${(bytes / 1e3).toFixed(0)}KB`
}
