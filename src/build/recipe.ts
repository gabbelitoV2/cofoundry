import type { RecipeInfo } from '@/config.ts'
import type { Env } from '@/env.ts'
import { selectBridge } from '@/build/packer.ts'
import { REPO_ROOT } from '@/build/repository.ts'

export type RecipeLayout = {
    hasPreseed: boolean
    hasAutoinstall: boolean
    hasKickstart: boolean
    isWindows: boolean
    needsBuildNetwork: boolean
}

const fileExists = (path: string): Promise<boolean> => Bun.file(path).exists()

export const inspectRecipeLayout = async (
    recipe: RecipeInfo
): Promise<RecipeLayout> => {
    const recipeDir = `${REPO_ROOT}recipes/${recipe.name}`
    const [hasPreseed, hasAutoinstall, hasKickstart] = await Promise.all([
        fileExists(`${recipeDir}/http/preseed.cfg`),
        fileExists(`${recipeDir}/http/user-data`),
        fileExists(`${recipeDir}/http/ks.cfg`),
    ])
    const isWindows = recipe.name.startsWith('windows-')
    return {
        hasPreseed,
        hasAutoinstall,
        hasKickstart,
        isWindows,
        needsBuildNetwork:
            hasPreseed || hasAutoinstall || hasKickstart || isWindows,
    }
}

export const bridgeForRecipe = (
    env: Env,
    recipe: RecipeInfo,
    layout: RecipeLayout
): string =>
    selectBridge(
        env,
        recipe.name,
        layout.hasPreseed,
        layout.hasAutoinstall,
        layout.hasKickstart
    )

export const injectedRecipeFiles = (
    remoteWorkDir: string,
    recipe: RecipeInfo,
    layout: RecipeLayout
): string[] => {
    const root = `${remoteWorkDir}/recipes/${recipe.name}`
    return [
        layout.hasPreseed ? `${root}/http/preseed.cfg` : undefined,
        layout.hasAutoinstall ? `${root}/http/user-data` : undefined,
        layout.hasKickstart ? `${root}/http/ks.cfg` : undefined,
        layout.hasKickstart ? `${root}/http/ks` : undefined,
        layout.isWindows ? `${root}/autounattend.xml` : undefined,
    ].filter((path): path is string => path !== undefined)
}
