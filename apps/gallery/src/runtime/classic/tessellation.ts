import { z } from 'zod';

const explicitTessellationSchema = z.object({
  segments: z.number().int().nonnegative().optional(),
  linearTolerance: z.number().positive().optional(),
  angularTolerance: z.number().positive().optional(),
});

export const classicRenderSchema = z.object({
  tessellation: z.union([z.enum(['low', 'medium', 'high', 'extra-high']), explicitTessellationSchema]).optional(),
});

export type ClassicTessellation = z.output<typeof classicRenderSchema>['tessellation'];

const presetSegments = { low: 16, medium: 32, high: 64, 'extra-high': 128 } as const;

/** Omission preserves authored $fn/$fa/$fs; an explicit request becomes the corresponding CLI overrides. */
export const classicResolution = (requested: ClassicTessellation): Record<string, number> => {
  if (typeof requested === 'string') {
    return { $fn: presetSegments[requested] };
  }
  if (!requested) {
    return {};
  }
  return {
    ...(requested.segments === undefined ? {} : { $fn: requested.segments }),
    ...(requested.linearTolerance === undefined ? {} : { $fs: requested.linearTolerance }),
    ...(requested.angularTolerance === undefined ? {} : { $fa: requested.angularTolerance }),
  };
};
