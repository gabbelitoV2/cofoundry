// Build-failure diagnostics: a tmpfs screenshot/log recorder that runs on the
// node during a build, and the local collector that pulls it down on failure.
// Split by concern under diagnostics/ — see docs/architecture.md#failure-diagnostics.
export { diagnosticsRemoteDir } from '@/build/diagnostics/paths.ts'
export { guestLogSpecs } from '@/build/diagnostics/guest-logs.ts'
export {
    buildDiagnosticsRecorder,
    recorderLifetimeSec,
    sweepStaleDiagnosticsCommand,
} from '@/build/diagnostics/recorder.ts'
export { collectDiagnostics } from '@/build/diagnostics/collect.ts'
export type { CollectDiagnosticsInput } from '@/build/diagnostics/collect.ts'
