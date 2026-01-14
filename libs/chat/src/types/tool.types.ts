import type { InferUITools, Tool as AiTool } from 'ai';
import type { toolName, toolMode, clientToolNames } from '#constants/tool.constants.js';
import type { EditFileInput, EditFileOutput } from '#schemas/tools/edit-file.tool.schema.js';
import type { ImageAnalysisInput, ImageAnalysisOutput } from '#schemas/tools/image-analysis.tool.schema.js';
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
  [toolName.imageAnalysis]: AiTool<ImageAnalysisInput, ImageAnalysisOutput>;
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
