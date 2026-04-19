/**
 * Shared Zod schema fragments for export options.
 *
 * Kernels compose these fragments via `.extend()` to build per-format export
 * option schemas. Tessellation schemas are kernel-specific — each kernel defines
 * its own tessellation fragment locally (see kernel plugin files).
 *
 * @public
 */

import { z } from 'zod';

/**
 * Coordinate system convention fragment for export formats that support
 * coordinate system transformation.
 * Compose into per-format schemas via `.extend()`.
 * @public
 */
export const coordinateSystemSchema = z.object({
  coordinateSystem: z.enum(['y-up', 'z-up']).default('z-up').describe('Output coordinate system convention'),
});

/**
 * Inferred type for coordinate system export options.
 * @public
 */
export type CoordinateSystemOptions = z.infer<typeof coordinateSystemSchema>;
