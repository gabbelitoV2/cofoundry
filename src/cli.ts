#!/usr/bin/env bun
import { Command } from 'commander'
import pkg from '../package.json' with { type: 'json' }
import { installRemoteSignalHandlers } from '@/build/remote.ts'
import { applyConfigToEnv, type ResolvedValue } from '@/config-file.ts'
import { registerBuildCommand } from '@/commands/build.ts'
import { registerConfigCommands } from '@/commands/config.ts'
import { registerMaintenanceCommands } from '@/commands/maintenance.ts'
import { registerPublishCommands } from '@/commands/publish.ts'
import { registerRecipeCommands } from '@/commands/recipes.ts'
import { log } from '@/log.ts'
import { redactSensitive } from '@/util.ts'

const resolveStartupConfig = (): ResolvedValue[] => {
    try {
        return applyConfigToEnv()
    } catch (error) {
        throw new Error(
            redactSensitive(
                error instanceof Error ? error.message : String(error)
            )
        )
    }
}

const main = async (): Promise<void> => {
    const program = new Command()
        .name('cf')
        .description('Proxmox template builder')
        .version(pkg.version)
    const configResolution = resolveStartupConfig()
    registerConfigCommands(program, configResolution)
    registerRecipeCommands(program)
    registerBuildCommand(program)
    registerMaintenanceCommands(program)
    registerPublishCommands(program)

    const removeSignalHandlers = installRemoteSignalHandlers()
    try {
        await program.parseAsync(process.argv)
    } finally {
        removeSignalHandlers()
    }
}

main().catch(error => {
    log.err(
        redactSensitive(error instanceof Error ? error.message : String(error))
    )
    process.exitCode = 1
})
