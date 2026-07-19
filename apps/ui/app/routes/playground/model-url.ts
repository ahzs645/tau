import { isGithubPagesBuild } from '#lib/deploy-target.js';

/**
 * Gallery-facing URL for a playground model. The static Pages gallery serves
 * each model at a root-level `/<model>` path (see the `:model` route in
 * `apps/ui/app/routes.ts`); the app build keeps the query-parameter form on
 * `/playground`.
 */
export function playgroundModelUrl(modelId: string): string {
  return isGithubPagesBuild ? `/${modelId}` : `/playground?model=${modelId}`;
}
