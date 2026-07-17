import type { Env } from '@/env.ts'

export type RemotePaths = {
    dump: string
    out: string
    work: string
    tmp: string
    isoStore: string
    downloadedIsoCache: string
}

export const remotePaths = (env: Pick<Env, 'PVE_DUMP_DIR'>): RemotePaths => ({
    dump: env.PVE_DUMP_DIR,
    out: `${env.PVE_DUMP_DIR}/cofoundry-out`,
    work: `${env.PVE_DUMP_DIR}/cofoundry-work`,
    tmp: `${env.PVE_DUMP_DIR}/cofoundry-tmp`,
    isoStore: '/var/lib/vz/template/iso',
    downloadedIsoCache: '/root/downloaded_iso_path',
})

export const buildRemoteOutDir = (env: Pick<Env, 'PVE_DUMP_DIR'>): string =>
    remotePaths(env).out

export const buildRemoteWorkDir = (env: Pick<Env, 'PVE_DUMP_DIR'>): string =>
    remotePaths(env).work

export const buildRemoteTmpDir = (env: Pick<Env, 'PVE_DUMP_DIR'>): string =>
    remotePaths(env).tmp
