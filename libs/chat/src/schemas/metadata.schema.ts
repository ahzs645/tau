import z from 'zod';
import { kernelProviders, manufacturingMethods, engineeringDisciplines } from '@taucad/types/constants';
import { toolNames, toolModes } from '#constants/tool.constants.js';
import { messageStatuses } from '#constants/message.constants.js';

/**
 * Schema for the editor context snapshot.
 * Provides the LLM with awareness of what the user is currently working on.
 */
export const snapshotSchema = z.object({
  /** Token-efficient tree representation of the project filesystem */
  filesystem: z.string().optional(),
  /** The file currently being rendered by the CAD engine */
  activeFile: z
    .object({
      path: z.string(),
      name: z.string(),
    })
    .optional(),
  /** The files currently open in editor tabs */
  openFiles: z
    .array(
      z.object({
        path: z.string(),
        name: z.string(),
      }),
    )
    .optional(),
});

export const messageMetadataSchema = z.object({
  usageCost: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cachedReadTokens: z.number(),
      cachedWriteTokens: z.number().optional(),
      inputTokensCost: z.number().optional(),
      outputTokensCost: z.number().optional(),
      cachedReadTokensCost: z.number().optional(),
      cachedWriteTokensCost: z.number().optional(),
      usageCost: z.number().optional(),
    })
    .optional(),
  toolChoice: z
    .union([
      // Allow single tool selection or array of tools
      z.enum(toolModes),
      z.array(z.enum(toolNames)),
    ])
    .optional(),
  kernel: z.enum(kernelProviders).optional(),
  manufacturingMethod: z.enum(manufacturingMethods).optional(),
  engineeringDiscipline: z.enum(Object.keys(engineeringDisciplines)).optional(),
  createdAt: z.number().optional(),
  status: z.enum(messageStatuses).optional(),
  model: z.string().optional(),
  /**
   * Snapshot of the user's editor context at message submission time.
   * Provides the LLM with awareness of what the user is currently working on.
   */
  snapshot: snapshotSchema.optional(),
});
