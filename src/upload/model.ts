export type Sidecar = {
    name: string
    display: string
    arch: string
    group: string
    sha256: string
    size: number
    suggested_vmid?: number
    url: string
    built_at: string
}

export type UploadOptions = {
    sourceDir?: string
    names?: string[]
    skipSidecar?: boolean
    dryRun?: boolean
    remote?: boolean
}

export type UploadSource = {
    listJsons: () => Promise<string[]>
    readJson: (name: string) => Promise<string>
    fileExists: (name: string) => Promise<boolean>
    pathOf: (name: string) => string
    exec: (command: string) => Promise<void>
    label: string
}
