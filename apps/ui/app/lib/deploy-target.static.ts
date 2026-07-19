/**
 * Deploy-target flags for the static GitHub Pages gallery build.
 *
 * Swapped in for `deploy-target.ts` via a Vite alias (see
 * `apps/ui/vite.config.ts`) when `GITHUB_PAGES=true`.
 */
// Widened so consumers can branch on it without tripping `no-unnecessary-condition`.
export const isGithubPagesBuild = true as boolean;
