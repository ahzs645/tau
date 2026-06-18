/**
 * Canonical raw source for replicad examples that are also surfaced as
 * standalone app playground projects.
 */
import petBottleOpenerCode from '#kernels/replicad/pet-bottle-opener/main.ts?raw';

/**
 * Raw `main.ts` source for replicad examples shared with app playgrounds, keyed
 * by the example folder name. A playground `project.json` sets
 * `"libSource": "<name>"` to pull this single source instead of duplicating the
 * code. The library is the source of truth: its `main.ts` is type-checked,
 * linted, and render-tested, and apps depend on this library (never the
 * reverse).
 *
 * @public
 */
export const replicadExampleCode: Record<string, string> = {
  'pet-bottle-opener': petBottleOpenerCode,
};
