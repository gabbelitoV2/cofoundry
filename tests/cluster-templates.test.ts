import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
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
import { delimiter, join, resolve } from 'node:path'
import { execa } from 'execa'

const roots: string[] = []

afterEach(async () => {
    await Promise.all(
        roots.splice(0).map(root => rm(root, { recursive: true, force: true }))
    )
})

// Git Bash on Windows needs POSIX-style paths in env vars and argv; a no-op
// elsewhere.
const bashPath = (p: string) =>
    process.platform === 'win32'
        ? p
              .replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`)
              .replace(/\\/g, '/')
        : p

const ARTIFACT_CONTENT = 'artifact-content'
const SHA256 = createHash('sha256').update(ARTIFACT_CONTENT).digest('hex')

// Two online nodes (fake TEST-NET-3 IPs so they never match a real local
// interface) plus one offline node without an "ip" field, mirroring the real
// pmxcfs format.
const MEMBERS = `{
"nodename": "pve1",
"version": 3,
"cluster": { "name": "cf", "version": 2, "nodes": 3, "quorate": 1 },
"nodelist": {
  "pve1": { "id": 1, "online": 1, "ip": "203.0.113.11"},
  "pve2": { "id": 2, "online": 1, "ip": "203.0.113.12"},
  "pve3": { "id": 3, "online": 0}
  }
}
`

type Fixture = {
    root: string
    dump: string
    artifact: string
    callsLog: string
    env: Record<string, string>
    args: string[]
}

const setup = async (): Promise<Fixture> => {
    const root = await mkdtemp(join(tmpdir(), 'cofoundry-cluster-'))
    roots.push(root)

    const bin = join(root, 'bin')
    const dump = join(root, 'dump')
    const out = join(root, 'out')
    await Promise.all([mkdir(bin), mkdir(dump), mkdir(out)])

    const artifact = join(out, 'debian-13-amd64.vma.zst')
    const members = join(root, 'members.json')
    const callsLog = join(root, 'calls.log')
    await Promise.all([
        writeFile(artifact, ARTIFACT_CONTENT),
        writeFile(members, MEMBERS),
        writeFile(callsLog, ''),
    ])

    // `ip` prints nothing so no cluster IP is ever treated as local — every
    // node goes through the ssh/scp stubs.
    const stubs: Record<string, string> = {
        ip: '#!/usr/bin/env bash\nexit 0\n',
        ssh: `#!/usr/bin/env bash
set -uo pipefail
printf 'ssh %s\\n' "$*" >>"$CALLS_LOG"
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    root@*) shift ;;
    *) args+=("$1"); shift ;;
  esac
done
if [ "\${args[0]:-}" = bash ] && [ "\${args[1]:-}" = -s ]; then
  exec bash -s
fi
exec bash -c "\${args[*]}"
`,
        scp: `#!/usr/bin/env bash
set -euo pipefail
printf 'scp %s\\n' "$*" >>"$CALLS_LOG"
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -q) shift ;;
    -o) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
dest="\${args[1]#*:}"
cp -f "\${args[0]}" "$dest"
if [ "\${SCP_CORRUPT:-}" = "1" ]; then
  printf 'CORRUPT' >>"$dest"
fi
`,
        qm: `#!/usr/bin/env bash
set -uo pipefail
printf 'qm %s\\n' "$*" >>"$CALLS_LOG"
case "\${1:-}" in
  status) if [ "\${QM_HAS_VM:-}" = "1" ]; then exit 0; else exit 1; fi ;;
  config) echo "template: 1" ;;
esac
exit 0
`,
        qmrestore: `#!/usr/bin/env bash
set -uo pipefail
printf 'qmrestore %s\\n' "$*" >>"$CALLS_LOG"
if [ "\${QMRESTORE_FAIL:-}" = "1" ]; then exit 1; fi
exit 0
`,
        pvesh: `#!/usr/bin/env bash
printf 'pvesh %s\\n' "$*" >>"$CALLS_LOG"
echo '[]'
`,
        python3: `#!/usr/bin/env bash
cat >/dev/null
echo local-lvm
`,
    }
    await Promise.all(
        Object.entries(stubs).map(async ([name, body]) => {
            await writeFile(join(bin, name), body)
            await chmod(join(bin, name), 0o755)
        })
    )

    return {
        root,
        dump,
        artifact,
        callsLog,
        env: {
            PATH: `${bin}${delimiter}${process.env.PATH}`,
            PVE_DUMP_DIR: bashPath(dump),
            CF_MEMBERS_FILE: bashPath(members),
            CF_BUILT_VMID: '4001',
            CALLS_LOG: bashPath(callsLog),
        },
        args: [resolve('scripts/cf-cluster-templates.sh'), bashPath(artifact)],
    }
}

const calls = async (fx: Fixture) =>
    (await readFile(fx.callsLog, 'utf8')).split('\n').filter(Boolean)

// cf-cluster-templates.sh is Proxmox-node orchestration: it drives ssh, scp,
// qmrestore, and `mapfile < <(...)` process substitution that hang under Git
// Bash on Windows. The script only ever runs on a Linux node, so gate the suite
// to POSIX rather than exercise it under an environment it never targets — the
// same rationale as the python-dependent prefetch tests.
const suite = process.platform === 'win32' ? describe.skip : describe

suite('cf-cluster-templates', () => {
    test('verifies the copy and restores a template on every online node', async () => {
        const fx = await setup()
        const result = await execa('bash', [...fx.args, SHA256], {
            env: fx.env,
            all: true,
            reject: false,
        })

        expect(result.exitCode).toBe(0)
        expect(result.all).toContain('[ok] template 14001')
        expect(result.all).toContain('[ok] template 24001')
        expect(result.all).toContain('2/2 node(s) ok, 0 failed, 1 offline')
        expect(result.all).toContain('[offline] pve3 (id 3)')

        const restores = (await calls(fx)).filter(c =>
            c.startsWith('qmrestore')
        )
        expect(restores).toHaveLength(2)
        expect(restores[0]).toContain(' 14001 --storage local-lvm')
        expect(restores[1]).toContain(' 24001 --storage local-lvm')
        // Success removes the per-node copies from the dump dir.
        expect(await readdir(fx.dump)).toEqual([])
    })

    test('leaves the existing template untouched and exits non-zero on a corrupt transfer', async () => {
        const fx = await setup()
        const result = await execa('bash', [...fx.args, SHA256], {
            env: { ...fx.env, SCP_CORRUPT: '1', QM_HAS_VM: '1' },
            all: true,
            reject: false,
        })

        expect(result.exitCode).toBe(1)
        expect(result.all).toContain('checksum mismatch')
        expect(result.all).toContain('0/2 node(s) ok, 2 failed, 1 offline')

        const log = await calls(fx)
        // One retry per node: two copies each.
        expect(log.filter(c => c.startsWith('scp'))).toHaveLength(4)
        // The existing template must never be destroyed or replaced.
        expect(log.some(c => c.includes('qm destroy'))).toBe(false)
        expect(log.some(c => c.startsWith('qmrestore'))).toBe(false)
        // The source artifact survives.
        expect(await readFile(fx.artifact, 'utf8')).toBe(ARTIFACT_CONTENT)
    })

    test('keeps the copied artifact and reports the state when the restore fails', async () => {
        const fx = await setup()
        const result = await execa('bash', [...fx.args, SHA256], {
            env: { ...fx.env, QMRESTORE_FAIL: '1' },
            all: true,
            reject: false,
        })

        expect(result.exitCode).toBe(1)
        expect(result.all).toContain('0/2 node(s) ok, 2 failed, 1 offline')
        // The cleanup trap undoes the vzdump-style rename instead of deleting
        // the copy, so a manual retry does not need a re-transfer.
        expect(await readdir(fx.dump)).toEqual(['debian-13-amd64.vma.zst'])
        expect(await readFile(fx.artifact, 'utf8')).toBe(ARTIFACT_CONTENT)
        // No prior template existed here, so the message must not claim one was
        // destroyed — only that none was created and the copy is retained.
        expect(result.all).toContain('no template was created at 14001')
        expect(result.all).toContain('kept at')
    })

    test('warns the node is left without a template when the restore fails after destroy', async () => {
        const fx = await setup()
        const result = await execa('bash', [...fx.args, SHA256], {
            env: { ...fx.env, QMRESTORE_FAIL: '1', QM_HAS_VM: '1' },
            all: true,
            reject: false,
        })

        expect(result.exitCode).toBe(1)
        // The previous template was destroyed before the failed restore, so the
        // operator is told this node now has no template at that id.
        expect(result.all).toContain(
            'previous template at 14001 was already destroyed'
        )
        expect(result.all).toContain('now has NO template at 14001')
        expect(result.all).toContain('for a manual retry')
        // The verified copy is still retained for that retry.
        expect(await readdir(fx.dump)).toEqual(['debian-13-amd64.vma.zst'])
    })

    test('verifies by default without a sha256, deriving it from the local artifact', async () => {
        const fx = await setup()
        const result = await execa('bash', fx.args, {
            env: fx.env,
            all: true,
            reject: false,
        })

        expect(result.exitCode).toBe(0)
        // Verification is on by default: it announces the self-computed hash
        // rather than warning that transfers go unchecked.
        expect(result.all).toContain('no sha256 given')
        expect(result.all).toContain("local artifact's own hash")
        expect(
            (await calls(fx)).filter(c => c.startsWith('qmrestore'))
        ).toHaveLength(2)
    })

    test('catches a corrupt transfer even when no sha256 is passed', async () => {
        const fx = await setup()
        const result = await execa('bash', fx.args, {
            env: { ...fx.env, SCP_CORRUPT: '1', QM_HAS_VM: '1' },
            all: true,
            reject: false,
        })

        expect(result.exitCode).toBe(1)
        expect(result.all).toContain('checksum mismatch')
        expect(result.all).toContain('0/2 node(s) ok, 2 failed, 1 offline')
        const log = await calls(fx)
        // No sha256 given, yet the corrupt copy is still caught before any
        // destructive step.
        expect(log.some(c => c.includes('qm destroy'))).toBe(false)
        expect(log.some(c => c.startsWith('qmrestore'))).toBe(false)
        expect(await readFile(fx.artifact, 'utf8')).toBe(ARTIFACT_CONTENT)
    })

    test('rejects a malformed sha256 argument', async () => {
        const fx = await setup()
        const result = await execa('bash', [...fx.args, 'not-a-digest'], {
            env: fx.env,
            all: true,
            reject: false,
        })

        expect(result.exitCode).toBe(1)
        expect(result.all).toContain('not a 64-char hex digest')
        expect(await calls(fx)).toEqual([])
    })
})
