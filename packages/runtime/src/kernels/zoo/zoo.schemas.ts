/**
 * Zoo (KCL) kernel Zod schemas — single source of truth.
 *
 * Consumed by `zoo.plugin.ts` (type inference) and `zoo.kernel.ts` (runtime validation).
 *
 * @public
 */

import { z } from 'zod';

/**
 * Zoo (KCL) kernel initialization options schema.
 * @public
 */
export const zooOptionsSchema = z.object({
  baseUrl: z.string().default('wss://api.zoo.dev'),
});

/**
 * Zoo per-format export schemas.
 * @public
 */
export const zooExportSchemas = {
  stl: z.object({
    binary: z.boolean().default(true).describe('Binary STL format'),
  }),
  step: z.object({}),
  glb: z.object({}),
  gltf: z.object({}),
} as const satisfies Record<string, z.ZodType>;
