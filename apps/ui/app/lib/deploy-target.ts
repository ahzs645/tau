/**
 * Deploy-target flags.
 *
 * The static GitHub Pages gallery build swaps this module for
 * `deploy-target.static.ts` via a Vite alias (see `apps/ui/vite.config.ts`),
 * the same mechanism used for the other `.static` module swaps. Every other
 * build (dev, Netlify, tests) resolves this default module.
 */
// Widened so consumers can branch on it without tripping `no-unnecessary-condition`.
export const isGithubPagesBuild = false as boolean;
