import type { Command } from 'commander'
import { execa } from 'execa'
import pc from 'picocolors'
import { captureRemoteScript } from '@/build/remote.ts'
import {
    runDoctorChecks,
    type CheckStatus,
    type DoctorDeps,
    type DoctorReport,
} from '@/doctor.ts'
import { log } from '@/log.ts'
import { redactSensitive } from '@/util.ts'

const STATUS_GLYPH: Record<CheckStatus, string> = {
    ok: pc.green('✔'),
    warn: pc.yellow('⚠'),
    fail: pc.red('✘'),
    skip: pc.dim('○'),
}

const DETAIL_COLOR: Record<CheckStatus, (s: string) => string> = {
    ok: pc.dim,
    warn: pc.yellow,
    fail: pc.red,
    skip: pc.dim,
}

const probeSsh = async (target: string): Promise<void> => {
    // BatchMode: never hang on a password prompt; accept-new keeps first
    // contact friction-free without silently accepting a *changed* host key.
    await execa(
        'ssh',
        [
            '-o',
            'BatchMode=yes',
            '-o',
            'ConnectTimeout=8',
            '-o',
            'StrictHostKeyChecking=accept-new',
            target,
            'true',
        ],
        { timeout: 12_000, stdin: 'ignore' }
    )
}

const defaultDeps: DoctorDeps = {
    whichLocal: bin => Bun.which(bin),
    probeSsh,
    captureScript: captureRemoteScript,
}

/** Machine-readable form for `cf doctor --json` (mirrors `cf config --json`:
 *  JSON on stdout, everything else on stderr). Details pass through the
 *  redactor since failure text may embed captured remote error output. */
export const doctorReportJson = (report: DoctorReport): string =>
    JSON.stringify(
        {
            ok: report.ok,
            checks: report.checks.map(check => ({
                ...check,
                detail: redactSensitive(check.detail),
                hint:
                    check.hint === undefined
                        ? undefined
                        : redactSensitive(check.hint),
            })),
        },
        null,
        2
    )

const renderReport = (report: DoctorReport): void => {
    log.section('Doctor')
    const width = Math.max(...report.checks.map(check => check.name.length))
    for (const check of report.checks) {
        log.raw(
            `  ${STATUS_GLYPH[check.status]} ${check.name.padEnd(width)}  ${DETAIL_COLOR[check.status](check.detail)}`
        )
        if (check.hint) log.raw(`    ${pc.dim(`↳ ${check.hint}`)}`)
    }
    log.blank()
}

export const runDoctorCommand = async (
    opts: { json?: boolean },
    deps: DoctorDeps = defaultDeps
): Promise<void> => {
    const report = await runDoctorChecks(process.env, deps)
    const failed = report.checks.filter(check => check.status === 'fail').length
    const warned = report.checks.filter(check => check.status === 'warn').length
    if (opts.json) {
        console.log(doctorReportJson(report))
    } else {
        renderReport(report)
        if (report.ok) {
            log.ok(
                warned > 0
                    ? `All checks passed (${warned} warning${warned === 1 ? '' : 's'}).`
                    : 'All checks passed.'
            )
            log.blank()
        }
    }
    // Warnings and skips exit 0; any failed check exits 1 (main() catches).
    if (!report.ok) throw new Error(`${failed} check(s) failed.`)
}

export const registerDoctorCommand = (program: Command): void => {
    program
        .command('doctor')
        .description(
            'Preflight diagnostics against the configured build node (env, SSH, tools, storage, bridges, API, disk space)'
        )
        .option('--json', 'Output as JSON')
        .action(async (opts: { json?: boolean }) => runDoctorCommand(opts))
}
