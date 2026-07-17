import { describe, expect, test } from 'bun:test'
import { remotePaths } from '@/build/paths.ts'

describe('remotePaths', () => {
    test('derives every build directory from the configured dump directory', () => {
        expect(remotePaths({ PVE_DUMP_DIR: '/custom/dump' })).toMatchObject({
            dump: '/custom/dump',
            out: '/custom/dump/cofoundry-out',
            work: '/custom/dump/cofoundry-work',
            tmp: '/custom/dump/cofoundry-tmp',
        })
    })
})
