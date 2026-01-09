import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StructuredTool } from '@langchain/core/tools';
import type { TavilySearch } from '@langchain/tavily';
import { OpenAI, OpenAIEmbeddings } from '@langchain/openai';
import type { ToolName, ToolMode, ToolSelection } from '@taucad/chat';
import { toolName, toolMode } from '@taucad/chat/constants';
import type { Environment } from '#config/environment.config.js';
import { createWebBrowserTool } from '#api/tools/tools/tool-web-browser.js';
import { editFileTool } from '#api/tools/tools/tool-file-edit.js';
import { imageAnalysisTool } from '#api/tools/tools/tool-image-analysis.js';
import { createWebSearchTool, parseWebSearchResults } from '#api/tools/tools/tool-web-search.js';
import { readFileTool } from '#api/tools/tools/tool-read-file.js';
import { listDirectoryTool } from '#api/tools/tools/tool-list-directory.js';
import { createFileTool } from '#api/tools/tools/tool-create-file.js';
import { deleteFileTool } from '#api/tools/tools/tool-delete-file.js';
import { grepTool } from '#api/tools/tools/tool-grep.js';
import { globSearchTool } from '#api/tools/tools/tool-glob-search.js';
import { getKernelResultTool } from '#api/tools/tools/tool-get-kernel-result.js';
import { reasoningTool, parseReasoningOutput } from '#api/tools/tools/tool-reasoning.js';

export const toolChoiceFromToolName = {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- Tavily search tool name
  tavily_search: toolName.webSearch,
} as const satisfies Record<string, ToolName>;

@Injectable()
export class ToolService {
  private webSearchTool: TavilySearch | undefined;

  public constructor(private readonly configService: ConfigService<Environment, true>) {}

  public getTools(selectedToolChoice: ToolSelection): {
    tools: Partial<Record<ToolName, StructuredTool>>;
    resolvedToolChoice: string;
  } {
    const model = new OpenAI({ temperature: 0 });
    const embeddings = new OpenAIEmbeddings();
    // Define the tools for the agent to use
    const toolCategoryToTool = {
      [toolName.webSearch]: this.getWebSearchTool(),
      [toolName.webBrowser]: createWebBrowserTool({
        model,
        embeddings,
        chunkSize: 2000,
        chunkOverlap: 200,
        maxChunks: 4,
        maxResults: 4,
        forceSummary: false,
      }),
      [toolName.editFile]: editFileTool,
      [toolName.imageAnalysis]: imageAnalysisTool,
      [toolName.readFile]: readFileTool,
      [toolName.listDirectory]: listDirectoryTool,
      [toolName.createFile]: createFileTool,
      [toolName.deleteFile]: deleteFileTool,
      [toolName.grep]: grepTool,
      [toolName.globSearch]: globSearchTool,
      [toolName.getKernelResult]: getKernelResultTool,
      [toolName.reasoning]: reasoningTool,
    } as const satisfies Partial<Record<ToolName, StructuredTool>>;

    const toolNameFromToolCategory = {
      [toolName.webSearch]: toolCategoryToTool[toolName.webSearch].name,
      [toolName.webBrowser]: toolCategoryToTool[toolName.webBrowser].name,
      [toolName.editFile]: toolCategoryToTool[toolName.editFile].name,
      [toolName.imageAnalysis]: toolCategoryToTool[toolName.imageAnalysis].name,
      [toolName.readFile]: toolCategoryToTool[toolName.readFile].name,
      [toolName.listDirectory]: toolCategoryToTool[toolName.listDirectory].name,
      [toolName.createFile]: toolCategoryToTool[toolName.createFile].name,
      [toolName.deleteFile]: toolCategoryToTool[toolName.deleteFile].name,
      [toolName.grep]: toolCategoryToTool[toolName.grep].name,
      [toolName.globSearch]: toolCategoryToTool[toolName.globSearch].name,
      [toolName.getKernelResult]: toolCategoryToTool[toolName.getKernelResult].name,
      [toolName.reasoning]: toolCategoryToTool[toolName.reasoning].name,
    } as const satisfies Partial<Record<ToolName, string>>;

    const toolNameFromToolChoice = {
      ...toolNameFromToolCategory,
      ...toolMode,
    } as const satisfies Partial<Record<ToolName | ToolMode, string>>;

    // Handle array of specific tools
    if (Array.isArray(selectedToolChoice)) {
      const filteredTools: Partial<Record<ToolName, StructuredTool>> = {};
      for (const toolChoiceItem of selectedToolChoice) {
        if (toolChoiceItem in toolCategoryToTool) {
          filteredTools[toolChoiceItem] = toolCategoryToTool[toolChoiceItem as keyof typeof toolCategoryToTool];
        }
      }

      return { tools: filteredTools, resolvedToolChoice: 'required' };
    }

    const resolvedToolChoice = toolNameFromToolChoice[selectedToolChoice];

    return { tools: toolCategoryToTool, resolvedToolChoice };
  }

  public getToolParsers(): Partial<Record<ToolName, (content: string) => unknown>> {
    return {
      [toolName.webSearch]: parseWebSearchResults,
      [toolName.reasoning]: parseReasoningOutput,
    };
  }

  private getWebSearchTool(): TavilySearch {
    if (!this.webSearchTool) {
      const tavilyApiKey = this.configService.get('TAVILY_API_KEY', { infer: true });
      if (!tavilyApiKey) {
        throw new Error('Tried to create web search tool without TAVILY_API_KEY in the environment variables');
      }

      this.webSearchTool = createWebSearchTool({ tavilyApiKey });
    }

    return this.webSearchTool;
  }
}
