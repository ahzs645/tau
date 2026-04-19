/**
 * Manifold kernel Zod schemas — single source of truth.
 *
 * Consumed by `manifold.plugin.ts` (type inference) and `manifold.kernel.ts` (runtime validation).
 *
 * @public
 */

import { z } from 'zod';

/**
 * Manifold kernel initialization options schema.
 * @public
 */
export const manifoldOptionsSchema = z.object({
  wasmUrl: z.string().optional(),
});

/**
 * Manifold per-format export schemas.
 * Empty — Manifold controls meshing internally.
 * @public
 */
export const manifoldExportSchemas = {
  glb: z.object({}),
} as const satisfies Record<string, z.ZodType>;
