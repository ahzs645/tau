import { Injectable } from '@nestjs/common';
import { openai } from '@ai-sdk/openai';
import { createAgent } from 'langchain';
import type { ReactAgent } from 'langchain';
import { streamText } from 'ai';
import type { ModelMessage } from 'ai';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { ConfigService } from '@nestjs/config';
import type { KernelProvider } from '@taucad/types';
import type { ToolSelection } from '@taucad/chat';
import { ModelService } from '#api/models/model.service.js';
import { usageTrackingMiddleware } from '#api/chat/middleware/usage-tracking.middleware.js';
import { messageLoggingMiddleware } from '#api/chat/middleware/message-logging.middleware.js';
import { createCachedSystemMessage } from '#api/chat/utils/create-cached-system-message.js';
import { ToolService } from '#api/tools/tool.service.js';
import { buildNameGenerationSystemPrompt } from '#api/chat/prompts/cad-name.prompt.js';
import { commitMessageGenerationSystemPrompt } from '#api/chat/prompts/git-commit.prompt.js';
import { getCadSystemPrompt } from '#api/chat/prompts/cad-agent.prompt.js';
import type { Environment } from '#config/environment.config.js';
import { toolResultTrimmerMiddleware } from '#api/chat/middleware/tool-result-trimmer.middleware.js';

@Injectable()
export class ChatService {
  public constructor(
    private readonly modelService: ModelService,
    private readonly toolService: ToolService,
    private readonly configService: ConfigService<Environment, true>,
  ) {}

  public getBuildNameGenerator(coreMessages: ModelMessage[]): ReturnType<typeof streamText> {
    return streamText({
      model: openai('gpt-4o-mini'),
      messages: coreMessages,
      system: buildNameGenerationSystemPrompt,
    });
  }

  public getCommitMessageGenerator(coreMessages: ModelMessage[]): ReturnType<typeof streamText> {
    return streamText({
      model: openai('gpt-4o-mini'),
      messages: coreMessages,
      system: commitMessageGenerationSystemPrompt,
    });
  }

  public async createAgent(
    modelId: string,
    selectedToolChoice: ToolSelection,
    selectedKernel: KernelProvider,
  ): Promise<ReactAgent> {
    const { tools } = this.toolService.getTools(selectedToolChoice);

    const databaseUrl = this.configService.get('DATABASE_URL', { infer: true });
    const checkpointer = PostgresSaver.fromConnString(databaseUrl, {
      schema: 'langgraph',
    });
    await checkpointer.setup();

    const { model } = this.modelService.buildModel(modelId);

    // Combine all tools into a single array for the unified agent
    const allTools = [
      // CAD and filesystem tools
      tools.edit_file,
      tools.analyze_image,
      tools.read_file,
      tools.list_directory,
      tools.create_file,
      tools.delete_file,
      tools.grep,
      tools.glob_search,
      tools.get_kernel_result,
      tools.reasoning,
      // Research tools
      tools.web_search,
      tools.web_browser,
    ].filter((tool) => tool !== undefined);

    // Build the system prompt with cache control for Anthropic prompt caching
    const systemPromptText = await getCadSystemPrompt(selectedKernel);
    const systemPrompt = createCachedSystemMessage(systemPromptText);

    // Create a unified agent with createAgent from LangChain v1
    // Uses SystemMessage with cache control for Anthropic prompt caching
    // Uses model instead of llm, and does NOT use pre-bound models with tools
    const agent = createAgent({
      model,
      tools: allTools,
      systemPrompt,
      checkpointer,
      middleware: [
        // Trim tool results (e.g., remove base64 images) before sending to the LLM
        toolResultTrimmerMiddleware,
        // Log messages before each model call (for debugging)
        messageLoggingMiddleware,
        // Track token usage and costs after each model call
        usageTrackingMiddleware,
      ],
    });

    return agent;
  }
}
