import { SystemMessage } from '@langchain/core/messages';

/**
 * Creates a SystemMessage with Anthropic cache control enabled.
 *
 * Uses cache_control: { type: 'ephemeral' } to cache the system prompt
 * on Anthropic's servers, reducing costs and latency for subsequent requests.
 *
 * For non-Anthropic models, the cache_control property is ignored.
 *
 * @param text - The system prompt text to cache
 * @returns A SystemMessage with cache control enabled
 */
export function createCachedSystemMessage(text: string): SystemMessage {
  return new SystemMessage({
    content: [
      {
        type: 'text',
        text,
        // eslint-disable-next-line @typescript-eslint/naming-convention -- Anthropic API uses snake_case
        cache_control: { type: 'ephemeral' },
      },
    ],
  });
}
