import { afterEach, describe, expect, test } from 'bun:test'
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'

const roots: string[] = []

afterEach(async () => {
    await Promise.all(
        roots.splice(0).map(root => rm(root, { recursive: true, force: true }))
    )
})

describe('vzdump post-processor cleanup', () => {
    test('removes the matching vzdump log after moving the artifact', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cofoundry-vzdump-'))
        roots.push(root)

        const bin = join(root, 'bin')
        const dump = join(root, 'dump')
        const out = join(root, 'out')
        await Promise.all([mkdir(bin), mkdir(dump), mkdir(out)])

        await writeFile(
            join(bin, 'qm'),
            '#!/usr/bin/env bash\nif [ "$1" = config ]; then echo "ostype: l26"; fi\n'
        )
        await writeFile(
            join(bin, 'vzdump'),
            `#!/usr/bin/env bash
set -euo pipefail
vmid="$1"
shift
while [ "$#" -gt 0 ]; do
  if [ "$1" = --dumpdir ]; then dumpdir="$2"; shift 2; else shift; fi
done
artifact="$dumpdir/vzdump-qemu-$vmid-2026_07_18-00_00_00.vma.zst"
printf artifact > "$artifact"
printf log > "\${artifact%.vma.zst}.log"
`
        )
        await Promise.all([
            chmod(join(bin, 'qm'), 0o755),
            chmod(join(bin, 'vzdump'), 0o755),
        ])

        await execa(
            'bash',
            [resolve('recipes/_shared/post/vzdump-and-cleanup.sh')],
            {
                env: {
                    PATH: `${bin}:${process.env.PATH}`,
                    SSH_TARGET: 'local',
                    PVE_DUMP_DIR: dump,
                    CF_OUT_DIR: out,
                    CF_RECIPE_NAME: 'debian-13',
                    CF_RECIPE_DISPLAY: 'Debian 13',
                    CF_BUILT_VMID: '400200',
                    CF_ARCH: 'amd64',
                    CF_GROUP: 'debian',
                },
            }
        )

        expect(await readdir(dump)).toEqual([])
        expect(
            await readFile(join(out, 'debian-13-amd64.vma.zst'), 'utf8')
        ).toBe('artifact')
        expect((await readdir(out)).sort()).toEqual([
            'debian-13-amd64.json',
            'debian-13-amd64.vma.zst',
        ])
    })
})
