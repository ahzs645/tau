/**
 * JSCAD kernel Zod schemas — single source of truth.
 *
 * Consumed by `jscad.plugin.ts` (type inference) and `jscad.kernel.ts` (runtime validation).
 *
 * @public
 */

import { z } from 'zod';

/**
 * JSCAD per-format export schemas.
 * Empty — JSCAD controls meshing internally.
 * @public
 */
export const jscadExportSchemas = {
  glb: z.object({}),
} as const satisfies Record<string, z.ZodType>;
