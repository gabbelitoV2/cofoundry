export const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

const sensitiveValues = new Set<string>()

export const addSensitiveValues = (...values: (string | undefined)[]): void => {
    for (const v of values) {
        if (v && v.length >= 4) sensitiveValues.add(v)
    }
}

export const redactSensitive = (msg: string): string => {
    let result = msg
    for (const v of sensitiveValues) result = result.replaceAll(v, '[REDACTED]')
    return result
}
