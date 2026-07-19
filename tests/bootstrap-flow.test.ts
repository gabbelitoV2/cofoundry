import { describe, expect, test } from 'bun:test'
import { formatSummaryTable } from '@/bootstrap/flow.ts'

describe('formatSummaryTable', () => {
    test('renders aligned terminal rows and borders', () => {
        const lines = formatSummaryTable([
            ['Build bridge', 'vmbr1'],
            ['Build subnet', '10.10.10.0/24'],
        ])
        expect(lines[0]).toStartWith('  ┌')
        expect(lines.at(-1)).toStartWith('  └')
        expect(lines).toContain('  │ Build bridge │ vmbr1         │')
        expect(lines).toContain('  │ Build subnet │ 10.10.10.0/24 │')
    })
})
