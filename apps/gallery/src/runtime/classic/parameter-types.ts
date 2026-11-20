import { z } from 'zod';

const parameterSchema = z.object({
  group: z.string(),
  initial: z.union([z.string(), z.number(), z.boolean(), z.array(z.number())]),
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean']),
  caption: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  options: z.array(z.object({ name: z.string(), value: z.union([z.string(), z.number()]) })).optional(),
});

export const parameterExportSchema = z.object({
  // The pinned CLI emits only { title } when a source has no Customizer controls.
  parameters: z.array(parameterSchema).default([]),
  title: z.string(),
});

export type ClassicParameter = z.output<typeof parameterSchema>;
export type ClassicParameterExport = z.output<typeof parameterExportSchema>;
export type ClassicValue = ClassicParameter['initial'];
