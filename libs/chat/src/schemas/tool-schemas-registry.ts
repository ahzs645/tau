import type { z } from 'zod';
import { toolName } from '#constants/tool.constants.js';
import { listDirectoryInputSchema, listDirectoryOutputSchema } from '#schemas/tools/list-directory.tool.schema.js';
import { readFileInputSchema, readFileOutputSchema } from '#schemas/tools/read-file.tool.schema.js';
import { createFileInputSchema, createFileOutputSchema } from '#schemas/tools/create-file.tool.schema.js';
import { deleteFileInputSchema, deleteFileOutputSchema } from '#schemas/tools/delete-file.tool.schema.js';
import { grepInputSchema, grepOutputSchema } from '#schemas/tools/grep.tool.schema.js';
import { globSearchInputSchema, globSearchOutputSchema } from '#schemas/tools/glob-search.tool.schema.js';
import {
  getKernelResultInputSchema,
  getKernelResultOutputSchema,
} from '#schemas/tools/get-kernel-result.tool.schema.js';
import {
  captureObservationsInputSchema,
  captureObservationsOutputSchema,
} from '#schemas/tools/capture-observations.tool.schema.js';

type ToolSchemaEntry = {
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
};

/**
 * Registry mapping tool names to their Zod schemas for validation.
 * Used by ChatToolsService to validate tool results from the client.
 *
 * Only client-side tools (executed via WebSocket) are included here.
 * Server-only tools don't need client-side validation.
 */
export const toolSchemasRegistry: Record<string, ToolSchemaEntry> = {
  [toolName.listDirectory]: {
    inputSchema: listDirectoryInputSchema,
    outputSchema: listDirectoryOutputSchema,
  },
  [toolName.readFile]: {
    inputSchema: readFileInputSchema,
    outputSchema: readFileOutputSchema,
  },
  [toolName.createFile]: {
    inputSchema: createFileInputSchema,
    outputSchema: createFileOutputSchema,
  },
  [toolName.deleteFile]: {
    inputSchema: deleteFileInputSchema,
    outputSchema: deleteFileOutputSchema,
  },
  [toolName.grep]: {
    inputSchema: grepInputSchema,
    outputSchema: grepOutputSchema,
  },
  [toolName.globSearch]: {
    inputSchema: globSearchInputSchema,
    outputSchema: globSearchOutputSchema,
  },
  [toolName.getKernelResult]: {
    inputSchema: getKernelResultInputSchema,
    outputSchema: getKernelResultOutputSchema,
  },
  [toolName.captureObservations]: {
    inputSchema: captureObservationsInputSchema,
    outputSchema: captureObservationsOutputSchema,
  },
};
