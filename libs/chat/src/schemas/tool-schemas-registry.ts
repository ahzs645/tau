import type { z } from 'zod';
import { toolName } from '#constants/tool.constants.js';
import { listDirectoryInputSchema, listDirectoryOutputSchema } from '#schemas/tools/list-directory.tool.schema.js';
import type { ListDirectoryInput, ListDirectoryOutput } from '#schemas/tools/list-directory.tool.schema.js';
import { readFileInputSchema, readFileOutputSchema } from '#schemas/tools/read-file.tool.schema.js';
import type { ReadFileInput, ReadFileOutput } from '#schemas/tools/read-file.tool.schema.js';
import { createFileInputSchema, createFileOutputSchema } from '#schemas/tools/create-file.tool.schema.js';
import type { CreateFileInput, CreateFileOutput } from '#schemas/tools/create-file.tool.schema.js';
import { deleteFileInputSchema, deleteFileOutputSchema } from '#schemas/tools/delete-file.tool.schema.js';
import type { DeleteFileInput, DeleteFileOutput } from '#schemas/tools/delete-file.tool.schema.js';
import { grepInputSchema, grepOutputSchema } from '#schemas/tools/grep.tool.schema.js';
import type { GrepInput, GrepOutput } from '#schemas/tools/grep.tool.schema.js';
import { globSearchInputSchema, globSearchOutputSchema } from '#schemas/tools/glob-search.tool.schema.js';
import type { GlobSearchInput, GlobSearchOutput } from '#schemas/tools/glob-search.tool.schema.js';
import {
  getKernelResultInputSchema,
  getKernelResultOutputSchema,
} from '#schemas/tools/get-kernel-result.tool.schema.js';
import type { GetKernelResultInput, GetKernelResultOutput } from '#schemas/tools/get-kernel-result.tool.schema.js';
import {
  captureObservationsInputSchema,
  captureObservationsOutputSchema,
} from '#schemas/tools/capture-observations.tool.schema.js';
import type {
  CaptureObservationsInput,
  CaptureObservationsOutput,
} from '#schemas/tools/capture-observations.tool.schema.js';

type ToolSchemaEntry<Input = unknown, Output = unknown> = {
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
};

/**
 * Type-safe registry mapping client tool names to their Zod schemas.
 * This provides compile-time type inference for tool inputs and outputs.
 */
export const toolSchemasRegistry = {
  [toolName.listDirectory]: {
    inputSchema: listDirectoryInputSchema,
    outputSchema: listDirectoryOutputSchema,
  } satisfies ToolSchemaEntry<ListDirectoryInput, ListDirectoryOutput>,
  [toolName.readFile]: {
    inputSchema: readFileInputSchema,
    outputSchema: readFileOutputSchema,
  } satisfies ToolSchemaEntry<ReadFileInput, ReadFileOutput>,
  [toolName.createFile]: {
    inputSchema: createFileInputSchema,
    outputSchema: createFileOutputSchema,
  } satisfies ToolSchemaEntry<CreateFileInput, CreateFileOutput>,
  [toolName.deleteFile]: {
    inputSchema: deleteFileInputSchema,
    outputSchema: deleteFileOutputSchema,
  } satisfies ToolSchemaEntry<DeleteFileInput, DeleteFileOutput>,
  [toolName.grep]: {
    inputSchema: grepInputSchema,
    outputSchema: grepOutputSchema,
  } satisfies ToolSchemaEntry<GrepInput, GrepOutput>,
  [toolName.globSearch]: {
    inputSchema: globSearchInputSchema,
    outputSchema: globSearchOutputSchema,
  } satisfies ToolSchemaEntry<GlobSearchInput, GlobSearchOutput>,
  [toolName.getKernelResult]: {
    inputSchema: getKernelResultInputSchema,
    outputSchema: getKernelResultOutputSchema,
  } satisfies ToolSchemaEntry<GetKernelResultInput, GetKernelResultOutput>,
  [toolName.captureObservations]: {
    inputSchema: captureObservationsInputSchema,
    outputSchema: captureObservationsOutputSchema,
  } satisfies ToolSchemaEntry<CaptureObservationsInput, CaptureObservationsOutput>,
} as const;

/**
 * Type representing the tool schemas registry.
 * Used for type inference in sendToolCallRequest.
 */
export type ToolSchemasRegistry = typeof toolSchemasRegistry;

/**
 * Helper type to extract input type for a given client tool name.
 */
export type ClientToolInput<T extends keyof ToolSchemasRegistry> = z.infer<ToolSchemasRegistry[T]['inputSchema']>;

/**
 * Helper type to extract output type for a given client tool name.
 */
export type ClientToolOutput<T extends keyof ToolSchemasRegistry> = z.infer<ToolSchemasRegistry[T]['outputSchema']>;
