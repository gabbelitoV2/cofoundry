import type { CheckResult } from '@/verify/guest.ts'
import type { CheckSeverity } from '@/verify/checks/types.ts'
import type { FrameAnalysis } from '@/verify/screenshot.ts'

export interface Summary {
    passed: number
    warned: number
    failed: number
}

export const summarize = (results: CheckResult[]): Summary => ({
    passed: results.filter(r => r.status === 'pass').length,
    warned: results.filter(r => r.status === 'warn').length,
    failed: results.filter(r => r.status === 'fail').length,
})

/**
 * Turn a framebuffer sample into a check result, so a blank console reports
 * through the same path as every guest-exec assertion.
 */
export const frameResult = (
    label: string,
    analysis: FrameAnalysis,
    threshold: number,
    severity: CheckSeverity
): CheckResult => {
    const uniform = analysis.uniformFraction >= threshold
    const pct = (analysis.uniformFraction * 100).toFixed(2)
    return {
        id: `console-not-blank:${label}`,
        description: `console framebuffer is not a uniform field (${label})`,
        status: uniform ? (severity === 'warn' ? 'warn' : 'fail') : 'pass',
        detail: uniform
            ? `${pct}% of pixels are ${analysis.dominantColor} — nothing painted`
            : '',
        output: `${analysis.width}x${analysis.height}, ${pct}% ${analysis.dominantColor}`,
        durationMs: 0,
    }
}

/** Lines for the failure message: what broke, and what the guest said about it. */
export const formatFailures = (results: CheckResult[]): string =>
    results
        .filter(r => r.status === 'fail')
        .map(r => {
            const head = `  ✗ ${r.id} — ${r.description} (${r.detail})`
            const body = r.output
                .split('\n')
                .filter(Boolean)
                .slice(0, 8)
                .map(l => `      ${l}`)
                .join('\n')
            return body ? `${head}\n${body}` : head
        })
        .join('\n')

export const formatWarnings = (results: CheckResult[]): string =>
    results
        .filter(r => r.status === 'warn')
        .map(r => `  ! ${r.id} — ${r.description} (${r.detail})`)
        .join('\n')
