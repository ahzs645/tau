import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { InferUITools, Tool as AiTool, UIToolInvocation } from 'ai';
import type { toolName, toolMode, clientToolNames } from '#constants/tool.constants.js';
import type { EditFileInput, EditFileOutput } from '#schemas/tools/edit-file.tool.schema.js';
import type {
  TestModelInput,
  TestModelOutput,
  EditTestsInput,
  EditTestsOutput,
} from '#schemas/tools/test-model.tool.schema.js';
import type { WebBrowserInput, WebBrowserOutput } from '#schemas/tools/web-browser.tool.schema.js';
import type { WebSearchInput, WebSearchOutput } from '#schemas/tools/web-search.tool.schema.js';
import type { ReadFileInput, ReadFileOutput } from '#schemas/tools/read-file.tool.schema.js';
import type { ListDirectoryInput, ListDirectoryOutput } from '#schemas/tools/list-directory.tool.schema.js';
import type { CreateFileInput, CreateFileOutput } from '#schemas/tools/create-file.tool.schema.js';
import type { DeleteFileInput, DeleteFileOutput } from '#schemas/tools/delete-file.tool.schema.js';
import type { GrepInput, GrepOutput } from '#schemas/tools/grep.tool.schema.js';
import type { GlobSearchInput, GlobSearchOutput } from '#schemas/tools/glob-search.tool.schema.js';
import type { GetKernelResultInput, GetKernelResultOutput } from '#schemas/tools/get-kernel-result.tool.schema.js';
import type { ReasoningInput, ReasoningOutput } from '#schemas/tools/reasoning.tool.schema.js';
import type {
  CaptureObservationsInput,
  CaptureObservationsOutput,
} from '#schemas/tools/capture-observations.tool.schema.js';
import type {
  TransferToCadExpertInput,
  TransferToCadExpertOutput,
} from '#schemas/tools/transfer-to-cad-expert.tool.schema.js';
import type {
  TransferToResearchExpertInput,
  TransferToResearchExpertOutput,
} from '#schemas/tools/transfer-to-research-expert.tool.schema.js';
import type {
  TransferBackToSupervisorInput,
  TransferBackToSupervisorOutput,
} from '#schemas/tools/transfer-back-to-supervisor.tool.schema.js';
import type { ToolExecutionError } from '#types/websocket.types.js';

export type ToolName = (typeof toolName)[keyof typeof toolName];

export type ClientToolName = (typeof clientToolNames)[number];

/**
 * The tool mode. One of:
 * - none: No tools are allowed
 * - auto: Let AI decide which tools to use
 * - any: Require tool use (all available)
 * - custom: Make these tools available
 */
export type ToolMode = (typeof toolMode)[keyof typeof toolMode];

/**
 * The tool selection is either a tool mode or an array of tool names.
 */
export type ToolSelection = ToolMode | ToolName[];

export type MyTools = InferUITools<{
  [toolName.editFile]: AiTool<EditFileInput, EditFileOutput>;
  [toolName.testModel]: AiTool<TestModelInput, TestModelOutput>;
  [toolName.editTests]: AiTool<EditTestsInput, EditTestsOutput>;
  [toolName.captureObservations]: AiTool<CaptureObservationsInput, CaptureObservationsOutput>;
  [toolName.webBrowser]: AiTool<WebBrowserInput, WebBrowserOutput>;
  [toolName.webSearch]: AiTool<WebSearchInput, WebSearchOutput>;
  [toolName.readFile]: AiTool<ReadFileInput, ReadFileOutput>;
  [toolName.listDirectory]: AiTool<ListDirectoryInput, ListDirectoryOutput>;
  [toolName.createFile]: AiTool<CreateFileInput, CreateFileOutput>;
  [toolName.deleteFile]: AiTool<DeleteFileInput, DeleteFileOutput>;
  [toolName.grep]: AiTool<GrepInput, GrepOutput>;
  [toolName.globSearch]: AiTool<GlobSearchInput, GlobSearchOutput>;
  [toolName.getKernelResult]: AiTool<GetKernelResultInput, GetKernelResultOutput>;
  [toolName.reasoning]: AiTool<ReasoningInput, ReasoningOutput>;
  [toolName.transferToCadExpert]: AiTool<TransferToCadExpertInput, TransferToCadExpertOutput>;
  [toolName.transferToResearchExpert]: AiTool<TransferToResearchExpertInput, TransferToResearchExpertOutput>;
  [toolName.transferBackToSupervisor]: AiTool<TransferBackToSupervisorInput, TransferBackToSupervisorOutput>;
}>;

/**
 * Type-safe tool invocation for a specific tool.
 * Wraps UIToolInvocation with the correct input/output types from MyTools.
 *
 * Usage: ToolInvocation<typeof toolName.readFile>
 */
export type ToolInvocation<T extends keyof MyTools> = UIToolInvocation<MyTools[T]>;

/**
 * A LangChain DynamicStructuredTool that can return either the success output
 * or a ToolExecutionError. This is used for all chat tools that communicate
 * with the client via WebSocket, where errors can occur during execution.
 *
 * @template SchemaT - The Zod schema type for the tool input
 * @template SchemaOutputT - The parsed output type from the schema (usually z.infer<SchemaT>)
 * @template SchemaInputT - The input type to the schema (usually same as SchemaOutputT)
 * @template SuccessOutputT - The success output type of the tool
 * @template NameT - The literal string type of the tool name
 *
 * @example
 * ```ts
 * export const myTool: ChatTool<
 *   typeof myInputSchema,
 *   MyInput,
 *   MyOutput,
 *   typeof toolName.myTool
 * > = tool(async (args, runtime) => {
 *   // ...
 * }, myToolDefinition);
 * ```
 */
export type ChatTool<
  SchemaT,
  SchemaOutputT,
  SuccessOutputT,
  NameT extends string,
  SchemaInputT = SchemaOutputT,
> = DynamicStructuredTool<SchemaT, SchemaOutputT, SchemaInputT, SuccessOutputT | ToolExecutionError, NameT>;
