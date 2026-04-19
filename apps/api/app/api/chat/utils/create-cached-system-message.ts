import { SystemMessage } from '@langchain/core/messages';

/**
 * Creates a SystemMessage with a 2-block cache architecture:
 *
 * - **Block 1 (static)**: Globally-cacheable prompt content (role, workflow,
 *   constraints, kernel-specific standards/examples). Gets `cache_control`
 *   with optional `scope: 'global'` for Anthropic cross-user cache sharing.
 * - **Block 2 (dynamic)**: Per-request content (transcript path, model info,
 *   git status, behavioral instructions). No `cache_control`.
 *
 * A third block (skills + memory) is inserted between these two by the
 * `clientContextMiddleware` at runtime, creating the final 3-block layout:
 * Block 1 (global) → Block 2 (workspace) → Block 3 (dynamic, uncached).
 *
 * For non-Anthropic models, `cache_control` is ignored by the API.
 *
 * @param options.staticPrompt - Globally stable prompt content (Block 1)
 * @param options.dynamicPrompt - Per-request dynamic content (final block)
 * @param options.useGlobalScope - When true, adds `scope: 'global'` to Block 1's cache_control (Anthropic only)
 */
export function createCachedSystemMessage(options: {
  staticPrompt: string;
  dynamicPrompt: string;
  useGlobalScope?: boolean;
}): SystemMessage {
  const cacheControl = options.useGlobalScope ? { type: 'ephemeral', scope: 'global' } : { type: 'ephemeral' };

  return new SystemMessage({
    content: [
      {
        type: 'text',
        text: options.staticPrompt,
        // eslint-disable-next-line @typescript-eslint/naming-convention -- Anthropic API uses snake_case
        cache_control: cacheControl,
      },
      {
        type: 'text',
        text: options.dynamicPrompt,
      },
    ],
  });
}
