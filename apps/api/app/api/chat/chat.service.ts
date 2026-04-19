import { Injectable } from '@nestjs/common';
import { openai } from '@ai-sdk/openai';
import { createAgent } from 'langchain';
import type { ReactAgent } from 'langchain';
import { streamText } from 'ai';
import type { ModelMessage } from 'ai';
import type { KernelProvider } from '@taucad/runtime';
import type { ToolSelection, ContextPayload } from '@taucad/chat';
import type { ChatMode } from '@taucad/chat/constants';
import { ModelService } from '#api/models/model.service.js';
import { createUsageTrackingMiddleware } from '#api/chat/middleware/usage-tracking.middleware.js';
import { createToolMetricsMiddleware } from '#api/chat/middleware/tool-metrics.middleware.js';
import { createLlmTimingMiddleware } from '#api/chat/middleware/llm-timing.middleware.js';
import { createAgentIterationsMiddleware } from '#api/chat/middleware/agent-iterations.middleware.js';
import { MetricsService } from '#telemetry/metrics.js';
import { messageLoggingMiddleware } from '#api/chat/middleware/message-logging.middleware.js';
import { toolErrorHandlerMiddleware } from '#api/chat/middleware/tool-error-handler.middleware.js';
import { createCachedSystemMessage } from '#api/chat/utils/create-cached-system-message.js';
import { ToolService } from '#api/tools/tool.service.js';
import { projectNameGenerationSystemPrompt } from '#api/chat/prompts/cad-name.prompt.js';
import { commitMessageGenerationSystemPrompt } from '#api/chat/prompts/git-commit.prompt.js';
import { getCadSystemPrompt } from '#api/chat/prompts/cad-agent.prompt.js';
import { toolResultTrimmerMiddleware } from '#api/chat/middleware/tool-result-trimmer.middleware.js';
import { promptCachingMiddleware } from '#api/chat/middleware/prompt-caching.middleware.js';
import { messageContentSanitizerMiddleware } from '#api/chat/middleware/message-content-sanitizer.middleware.js';
import { latexDelimiterMiddleware } from '#api/chat/middleware/latex-delimiter.middleware.js';
import { newlineTrimmerMiddleware } from '#api/chat/middleware/newline-trimmer.middleware.js';
import { createCompactionMiddleware } from '#api/chat/middleware/compaction.middleware.js';
import { createToolOffloadingMiddleware } from '#api/chat/middleware/tool-offloading.middleware.js';
import { createTranscriptMiddleware } from '#api/chat/middleware/transcript.middleware.js';
import { createContextUsageMiddleware } from '#api/chat/middleware/context-usage.middleware.js';
import { CheckpointerService } from '#api/chat/checkpointer.service.js';
import { CompactionService } from '#api/chat/compaction.service.js';
import { TauRpcBackendFactory } from '#api/chat/tau-rpc-backend.js';
import { ChatRpcService } from '#api/chat/chat-rpc.service.js';
import { createClientContextMiddleware } from '#api/chat/middleware/client-context.middleware.js';
import { Span } from '#telemetry/tracer.service.js';

@Injectable()
export class ChatService {
  public constructor(
    private readonly modelService: ModelService,
    private readonly toolService: ToolService,
    private readonly checkpointerService: CheckpointerService,
    private readonly metricsService: MetricsService,
    private readonly compactionService: CompactionService,
    private readonly rpcBackendFactory: TauRpcBackendFactory,
    private readonly chatRpcService: ChatRpcService,
  ) {}

  @Span()
  public async createAgent(options: {
    chatId: string;
    modelId: string;
    kernel: KernelProvider;
    mode?: ChatMode;
    tools: {
      choice: ToolSelection;
      testingEnabled?: boolean;
    };
    contextPayload?: ContextPayload;
  }): Promise<ReactAgent> {
    const { chatId, modelId, kernel, mode = 'agent', contextPayload } = options;
    const { choice, testingEnabled = true } = options.tools;
    const { tools } = this.toolService.getTools(choice);

    const checkpointer = this.checkpointerService.getCheckpointer();

    const { model } = this.modelService.buildModel(modelId);

    // Combine all tools into a single array for the unified agent
    const allTools = [
      // CAD tools (testing tools conditionally included)
      ...(testingEnabled ? [tools.test_model, tools.edit_tests] : []),
      tools.get_kernel_result,
      tools.screenshot,
      // Filesystem tools
      tools.edit_file,
      tools.read_file,
      tools.list_directory,
      tools.create_file,
      tools.delete_file,
      tools.grep,
      tools.glob_search,
      // Research tools
      tools.web_search,
      tools.web_browser,
    ].filter((tool) => tool !== undefined);

    // ==========================================================================
    // Prompt Caching Strategy (3 breakpoints)
    // ==========================================================================
    // Block 1 (static): Globally-cached system prompt (role, workflow, kernel config)
    //   → cache_control: { type: 'ephemeral', scope: 'global' } (Anthropic only)
    // Block 2 (workspace): Skills + memory, injected by clientContextMiddleware
    //   → cache_control: { type: 'ephemeral' }
    // Block 3 (dynamic): Per-request content (model info, git status, transcript path)
    //   → No cache_control
    // Last message: Incremental conversation caching via promptCachingMiddleware
    //   → cache_control: { type: 'ephemeral' }
    //
    // 3 of 4 Anthropic breakpoint slots used, 1 reserved.
    // ==========================================================================
    const contextWindow = this.modelService.getContextWindow(modelId);
    const knowledgeCutoff = this.modelService.getKnowledgeCutoff(modelId);
    const gitStatus = contextPayload?.gitStatus;
    const { static: staticPrompt, dynamic: dynamicPrompt } = await getCadSystemPrompt(kernel, mode, testingEnabled, {
      chatId,
      modelId,
      contextWindow,
      knowledgeCutoff,
      gitStatus,
    });
    // Global cache scope is currently disabled: enabling it requires the
    // `prompt-caching-scope-2026-01-05` Anthropic beta on the configured API key.
    // When the beta is available switch this to `getProviderId(modelId) === 'anthropic'`.
    const useGlobalScope = false;
    const systemPrompt = createCachedSystemMessage({ staticPrompt, dynamicPrompt, useGlobalScope });

    const agent = createAgent({
      model,
      tools: allTools,
      systemPrompt,
      checkpointer,
      middleware: [
        // --- Metrics and error handling ---
        createToolMetricsMiddleware(this.metricsService),
        toolErrorHandlerMiddleware,

        // --- Context prevention (offload large tool results before trimming) ---
        createToolOffloadingMiddleware(this.rpcBackendFactory),
        toolResultTrimmerMiddleware,

        // --- Context compaction ---
        createCompactionMiddleware(this.compactionService, this.rpcBackendFactory, this.chatRpcService),

        // --- Message processing ---
        messageContentSanitizerMiddleware,
        newlineTrimmerMiddleware,
        latexDelimiterMiddleware,

        // --- Prompt caching (must follow compaction) ---
        promptCachingMiddleware,

        // --- Logging and observability ---
        messageLoggingMiddleware,
        createLlmTimingMiddleware(this.metricsService),
        createAgentIterationsMiddleware(this.metricsService),
        createUsageTrackingMiddleware(this.metricsService),
        createContextUsageMiddleware(),

        // --- Transcript (captures final state) ---
        createTranscriptMiddleware(this.chatRpcService),

        // --- Client-side context injection (skills catalog + AGENTS.md memory) ---
        createClientContextMiddleware(contextPayload),
      ],
    });

    return agent;
  }

  public getBuildNameGenerator(coreMessages: ModelMessage[]): ReturnType<typeof streamText> {
    return streamText({
      model: openai('gpt-4o-mini'),
      messages: coreMessages,
      system: projectNameGenerationSystemPrompt,
    });
  }

  public getCommitMessageGenerator(coreMessages: ModelMessage[]): ReturnType<typeof streamText> {
    return streamText({
      model: openai('gpt-4o-mini'),
      messages: coreMessages,
      system: commitMessageGenerationSystemPrompt,
    });
  }
}
