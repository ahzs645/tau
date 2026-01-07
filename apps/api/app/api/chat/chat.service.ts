import { Injectable, Logger } from '@nestjs/common';
import { openai } from '@ai-sdk/openai';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { streamText } from 'ai';
import type { ModelMessage } from 'ai';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { ConfigService } from '@nestjs/config';
import type { KernelProvider } from '@taucad/types';
import type { ToolSelection } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import { ModelService } from '#api/models/model.service.js';
import { ToolService } from '#api/tools/tool.service.js';
import { buildNameGenerationSystemPrompt } from '#api/chat/prompts/chat-prompt-name.js';
import { commitMessageGenerationSystemPrompt } from '#api/chat/prompts/commit-message-prompt.js';
import type { LangGraphAdapterCallbacks } from '#api/chat/utils/langgraph-adapter.js';
import { getCadSystemPrompt } from '#api/chat/prompts/chat-prompt-cad.js';
import { normalizeError } from '#api/chat/utils/error-normalizer.js';
import { createCacheableSystemMessage } from '#api/chat/utils/convert-messages.js';
import type { Environment } from '#config/environment.config.js';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

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

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- This is a complex generic that can be left inferred.
  public async createGraph(modelId: string, selectedToolChoice: ToolSelection, selectedKernel: KernelProvider) {
    const { tools } = this.toolService.getTools(selectedToolChoice);

    const databaseUrl = this.configService.get('DATABASE_URL', { infer: true });
    const checkpointer = PostgresSaver.fromConnString(databaseUrl, {
      schema: 'langgraph',
    });
    await checkpointer.setup();

    const { model, support } = this.modelService.buildModel(modelId);

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

    // Build the unified system prompt
    const cadSystemPrompt = await getCadSystemPrompt(selectedKernel);
    const unifiedSystemPrompt = `${cadSystemPrompt}

<research_capabilities>
## Web Research Tools
You also have access to web research tools for gathering information:

- **\`${toolName.webSearch}\`**: Search the web for current information, documentation, tutorials, or any external knowledge needed to complete your task. Use this when you need to look up technical details, find examples, or research best practices.

- **\`${toolName.webBrowser}\`**: Browse specific web pages to extract detailed information. Use this only when the web search results are insufficient and you need to dive deeper into a specific URL.

**When to use research tools:**
- When you need current information about libraries, APIs, or techniques
- When the user asks about topics outside your training data
- When you need to look up specifications, dimensions, or reference materials for CAD models
- When researching best practices for specific manufacturing techniques

Always prefer \`${toolName.webSearch}\` first, and only use \`${toolName.webBrowser}\` if the search results don't provide enough detail.
</research_capabilities>`;

    // Create a cacheable system message to enable Anthropic prompt caching.
    // This significantly reduces costs (up to 90%) and latency (up to 85%) for
    // repeated prompts by marking the system prompt content for caching.
    const systemMessage = createCacheableSystemMessage(unifiedSystemPrompt);

    // Create a single unified agent with all tools and persistence
    const agent = createReactAgent({
      llm: support?.tools === false ? model : (model.bindTools?.(allTools) ?? model),
      tools: allTools,
      name: 'cad_assistant',
      prompt: systemMessage,
      checkpointer,
    });

    return agent;
  }

  public getCallbacks(): LangGraphAdapterCallbacks {
    const { logger, modelService } = this;
    // Accumulate per-turn usage data for multi-turn agent calls
    type TurnUsage = {
      turnIndex: number;
      inputTokens: number;
      outputTokens: number;
      cachedReadTokens: number;
      cachedWriteTokens: number;
      inputTokensCost: number;
      outputTokensCost: number;
      cachedReadTokensCost: number;
      cachedWriteTokensCost: number;
      usageCost: number;
    };
    const turns: TurnUsage[] = [];

    return {
      onChatModelEnd({ dataStream, modelId: id, usageTokens }) {
        // Emit per-turn usage metadata, accumulating all turns
        const normalizedUsageTokens = modelService.normalizeUsageTokens(id, usageTokens);
        const turnUsageCost = modelService.getModelCost(id, normalizedUsageTokens);

        turns.push({
          turnIndex: turns.length,
          inputTokens: normalizedUsageTokens.inputTokens,
          outputTokens: normalizedUsageTokens.outputTokens,
          cachedReadTokens: normalizedUsageTokens.cachedReadTokens,
          cachedWriteTokens: normalizedUsageTokens.cachedWriteTokens,
          inputTokensCost: turnUsageCost.inputTokensCost,
          outputTokensCost: turnUsageCost.outputTokensCost,
          cachedReadTokensCost: turnUsageCost.cachedReadTokensCost,
          cachedWriteTokensCost: turnUsageCost.cachedWriteTokensCost,
          usageCost: turnUsageCost.totalCost,
        });

        dataStream.write({
          type: 'message-metadata',
          messageMetadata: {
            turns: [...turns],
            model: id,
          },
        });
      },
      onError(error) {
        if (error instanceof Error && error.message === 'Aborted') {
          logger.warn('Request aborted');
          return JSON.stringify({
            category: 'generic',
            title: 'Aborted',
            message: 'The request was aborted',
          });
        }

        logger.error('Error in chat stream follows:');
        logger.error(error);

        // Use the error normalizer to create a structured error response
        const normalized = normalizeError(error);

        return normalized;
      },
    };
  }
}
