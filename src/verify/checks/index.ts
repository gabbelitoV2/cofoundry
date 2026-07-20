import type { RecipeInfo } from '@/config.ts'
import type { CheckSuite, GuestCheck } from '@/verify/checks/types.ts'
import { linuxSuite } from '@/verify/checks/linux.ts'
import { windowsSuite } from '@/verify/checks/windows.ts'

export const isWindowsRecipe = (name: string): boolean =>
    name.startsWith('windows-')

/**
 * Per-recipe additions and overrides, keyed by recipe name. A check whose id
 * matches a base check replaces it (use this to relax or retarget one
 * assertion); any other check is appended.
 *
 * Keep this empty unless a recipe genuinely differs — a check that belongs to
 * every Linux image belongs in `linuxSuite`, not repeated here.
 */
const RECIPE_OVERRIDES: Record<string, GuestCheck[]> = {}

export const mergeChecks = (
    base: GuestCheck[],
    overrides: GuestCheck[]
): GuestCheck[] => {
    const byId = new Map(overrides.map(c => [c.id, c]))
    const merged = base.map(c => byId.get(c.id) ?? c)
    const usedIds = new Set(base.map(c => c.id))
    return [...merged, ...overrides.filter(c => !usedIds.has(c.id))]
}

export const suiteFor = (recipe: RecipeInfo): CheckSuite => {
    const base = isWindowsRecipe(recipe.name) ? windowsSuite : linuxSuite
    const overrides = RECIPE_OVERRIDES[recipe.name] ?? []
    if (overrides.length === 0) return base
    return { ...base, checks: mergeChecks(base.checks, overrides) }
}

export type { CheckSuite, GuestCheck }
