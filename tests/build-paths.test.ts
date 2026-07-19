import { describe, expect, test } from 'bun:test'
import { buildRemoteSnapshotDir, remotePaths } from '@/build/paths.ts'

describe('remotePaths', () => {
    test('derives every build directory from the configured dump directory', () => {
        expect(remotePaths({ PVE_DUMP_DIR: '/custom/dump' })).toMatchObject({
            dump: '/custom/dump',
            out: '/custom/dump/cofoundry-out',
            work: '/custom/dump/cofoundry-work',
            tmp: '/custom/dump/cofoundry-tmp',
            snapshots: '/custom/dump/cofoundry-snapshots',
            assetCache: '/custom/dump/cofoundry-cache',
        })
        expect(
            buildRemoteSnapshotDir({ PVE_DUMP_DIR: '/custom/dump' }, 'abc123')
        ).toBe('/custom/dump/cofoundry-snapshots/abc123')
    })
})
