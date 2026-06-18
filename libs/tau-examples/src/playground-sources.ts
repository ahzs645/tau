/**
 * Raw `main.ts` source for replicad examples shared with app playgrounds, keyed
 * by the example folder name. A playground `project.json` sets
 * `"libSource": "<name>"` to pull a single canonical source from this library
 * instead of duplicating the code.
 *
 * Currently empty: every playground project owns its own source under
 * `apps/ui/app/routes/playground/projects/<id>/`. This map (and the `libSource`
 * mechanism) remains available should a future project want to reuse a
 * library-owned example verbatim.
 *
 * @public
 */
export const replicadExampleCode: Record<string, string> = {};
