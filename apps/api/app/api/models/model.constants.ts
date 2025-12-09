import type { Model } from '#api/models/model.schema.js';
import type { CloudProviderId } from '#api/models/model.service.js';

export const modelList: Record<CloudProviderId, Record<string, Model>> = {
  vertexai: {
    'gemini-3-pro': {
      id: 'google-gemini-3-pro',
      name: 'Gemini 3 Pro',
      slug: 'gemini-3-pro',
      provider: {
        id: 'vertexai',
        name: 'Google',
      },
      model: 'gemini-3-pro-preview',
      details: {
        family: 'gemini',
        families: ['Gemini'],
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        cost: {
          inputTokens: 1.25, // Verify from official pricing
          outputTokens: 10, // Verify from official pricing
          cachedReadTokens: 0,
          cachedWriteTokens: 0,
        },
      },
      configuration: {
        streaming: true,
        temperature: 0,
        // New: thinkingLevel: 'high', // if you want to enable extended thinking
      },
    },
  },

  anthropic: {
    'claude-sonnet-4.5': {
      id: 'anthropic-claude-sonnet-4.5',
      name: 'Sonnet 4.5',
      slug: 'claude-sonnet-4.5',
      provider: {
        id: 'anthropic',
        name: 'Anthropic',
      },
      model: 'claude-sonnet-4-5-20250929',
      details: {
        family: 'claude',
        families: ['Claude'],
        contextWindow: 200_000,
        // Sonnet 4.5 supports standard output up to 8192 tokens
        maxTokens: 8192,
        cost: {
          inputTokens: 3,
          outputTokens: 15,
          cachedReadTokens: 0.3,
          cachedWriteTokens: 3.75,
        },
      },
      configuration: {
        streaming: true,
        temperature: 0,
      },
    },
    'claude-sonnet-4.5-thinking': {
      id: 'anthropic-claude-sonnet-4.5-thinking',
      name: 'Sonnet 4.5 (Extended Thinking)',
      slug: 'claude-sonnet-4.5-thinking',
      provider: {
        id: 'anthropic',
        name: 'Anthropic',
      },
      model: 'claude-sonnet-4-5-20250929',
      support: {
        toolChoice: false,
      },
      details: {
        family: 'claude',
        families: ['Claude'],
        contextWindow: 200_000,
        // Extended thinking mode supports up to 64000 tokens
        maxTokens: 64_000,
        cost: {
          inputTokens: 3,
          outputTokens: 15,
          cachedReadTokens: 0.3,
          cachedWriteTokens: 3.75,
        },
      },
      configuration: {
        streaming: true,
        maxTokens: 20_000,
        // @ts-expect-error: FIXME - some models use camelCase
        // eslint-disable-next-line @typescript-eslint/naming-convention -- some models use snake_case
        max_tokens: 20_000,
        thinking: {
          type: 'enabled',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- some models use snake_case
          budget_tokens: 10_000,
        },
      },
    },
    'claude-4.5-opus': {
      id: 'anthropic-claude-opus-4.5',
      name: 'Opus 4.5',
      slug: 'claude-opus-4.5',
      provider: {
        id: 'anthropic',
        name: 'Anthropic',
      },
      model: 'claude-opus-4-5-20251101',
      support: {
        toolChoice: false,
      },
      details: {
        family: 'claude',
        families: ['Claude'],
        contextWindow: 200_000,
        maxTokens: 32_000,
        cost: {
          inputTokens: 5,
          outputTokens: 25,
          cachedReadTokens: 0.5,
          cachedWriteTokens: 6.25,
        },
      },
      configuration: {
        streaming: true,
        maxTokens: 20_000,
        // @ts-expect-error: FIXME - some models use camelCase
        // eslint-disable-next-line @typescript-eslint/naming-convention -- some models use snake_case
        max_tokens: 20_000,
        thinking: {
          type: 'enabled',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- some models use snake_case
          budget_tokens: 5000,
        },
      },
    },
  },
  openai: {
    'gpt-5.1': {
      id: 'openai-gpt-5.1',
      name: 'GPT-5.1',
      slug: 'gpt-5.1',
      provider: {
        id: 'openai',
        name: 'OpenAI',
      },
      model: 'gpt-5.1',
      details: {
        family: 'gpt',
        families: ['GPT-5.1'],
        contextWindow: 1_000_000,
        maxTokens: 100_000,
        cost: {
          inputTokens: 2,
          outputTokens: 8,
          cachedReadTokens: 0.5,
          cachedWriteTokens: 0,
        },
      },
      configuration: {
        streaming: true,
        temperature: 1,
        // @ts-expect-error: OpenAI reasoning params not in typed schema
        reasoningText: {
          effort: 'medium',
        },
      },
    },
    'gpt-4.1': {
      id: 'openai-gpt-4.1',
      name: 'GPT-4.1',
      slug: 'gpt-4.1',
      provider: {
        id: 'openai',
        name: 'OpenAI',
      },
      model: 'gpt-4.1',
      details: {
        family: 'gpt',
        families: ['GPT-4.1'],
        contextWindow: 1_047_576,
        maxTokens: 32_768,
        cost: {
          inputTokens: 2,
          outputTokens: 8,
          cachedReadTokens: 0.5,
          cachedWriteTokens: 0,
        },
      },
      configuration: {
        streaming: true,
      },
    },
  },
} as const;
