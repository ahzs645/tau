import type { UIMessageChunk } from 'ai';
import { toolNames } from '@taucad/chat/constants';

/**
 * Set of all known static tool names from the chat library.
 * Tools in this set will have the `dynamic` flag stripped from their stream events.
 */
const staticToolNames = new Set<string>(toolNames);

/**
 * Type guard for tool input events that may have a dynamic flag.
 */
type ToolInputEvent = UIMessageChunk & {
  type: 'tool-input-start' | 'tool-input-available';
  toolName: string;
  dynamic?: boolean;
};

/**
 * Checks if a chunk is a tool input event.
 */
function isToolInputEvent(chunk: UIMessageChunk): chunk is ToolInputEvent {
  return chunk.type === 'tool-input-start' || chunk.type === 'tool-input-available';
}

/**
 * Creates a TransformStream that strips the `dynamic` flag from tool input events
 * for known static tools.
 *
 * The `@ai-sdk/langchain` adapter's `toUIMessageStream()` marks ALL tools as `dynamic: true`
 * because it has no knowledge of which tools are statically defined. This transform
 * corrects that by removing the `dynamic` flag for tools that are known to be static.
 *
 * @returns A TransformStream that processes UIMessageChunk events
 */
export function createStaticToolTransform(): TransformStream<UIMessageChunk, UIMessageChunk> {
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      // Check if this is a tool input event for a known static tool
      if (isToolInputEvent(chunk) && staticToolNames.has(chunk.toolName)) {
        // Strip the dynamic flag for static tools
        const { dynamic: _, ...rest } = chunk;
        controller.enqueue(rest as UIMessageChunk);
        return;
      }

      // Pass through all other events unchanged
      controller.enqueue(chunk);
    },
  });
}
