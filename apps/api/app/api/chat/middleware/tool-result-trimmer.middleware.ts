import { createMiddleware } from 'langchain';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { toolName } from '@taucad/chat/constants';
import type { TestModelOutput } from '@taucad/chat';

/**
 * Type for a tool result trimmer function.
 * Takes the parsed tool result and returns a trimmed version.
 */
type ToolResultTrimmer<T = unknown> = (result: T) => T;

/**
 * Type for a content shape detector function.
 * Returns true if the parsed content matches the expected shape for a tool.
 */
type ContentShapeDetector = (content: unknown) => boolean;

/**
 * Checks if content has the shape of TestModelOutput.
 * Looks for a failures array and total count.
 */
function isTestModelShape(content: unknown): boolean {
  if (typeof content !== 'object' || content === null) {
    return false;
  }

  const record = content as Record<string, unknown>;

  return Array.isArray(record['failures']) && typeof record['total'] === 'number';
}

/**
 * Registry of content shape detectors.
 * Maps tool names to functions that detect if content matches that tool's output shape.
 * Used as a fallback when message.name is undefined.
 */
const contentShapeDetectors: Record<string, ContentShapeDetector> = {
  [toolName.testModel]: isTestModelShape,
};

/**
 * Detects the tool name based on the shape of the parsed content.
 * Returns undefined if no matching shape is found.
 */
function detectToolNameFromContent(content: unknown): string | undefined {
  for (const [name, detector] of Object.entries(contentShapeDetectors)) {
    if (detector(content)) {
      return name;
    }
  }

  return undefined;
}

/**
 * Registry of tool result trimmers.
 * Each key is a tool name, and the value is a function that trims the result.
 */
const toolResultTrimmers: Record<string, ToolResultTrimmer> = {
  /**
   * Trims the test model result by removing the 'passed' count.
   * The LLM can infer it from total - failures.length if needed.
   * The output is already minimal (failures only), so this is a minor optimization.
   */
  [toolName.testModel](result: unknown): unknown {
    const typedResult = result as TestModelOutput;

    // Remove 'passed' count - LLM can infer from total - failures.length
    return {
      failures: typedResult.failures,
      total: typedResult.total,
    };
  },
};

/**
 * Type guard to check if a message is a ToolMessage or a deserialized plain object
 * that represents a ToolMessage.
 *
 * Handles three cases:
 * 1. Actual ToolMessage instances (via ToolMessage.isInstance)
 * 2. Plain objects deserialized from checkpoint storage with type: "tool"
 * 3. Messages that have getType method returning "tool" (deprecated LangChain pattern)
 */
function isToolMessage(message: BaseMessage): message is ToolMessage {
  // Check for actual ToolMessage instances first
  if (ToolMessage.isInstance(message)) {
    return true;
  }

  // Check for deserialized plain objects with type: "tool"
  // These lose their prototype chain when stored/loaded from PostgresSaver
  // Cast through unknown to access properties on potentially deserialized objects
  const messageRecord = message as unknown as Record<string, unknown>;

  // Check for type property (present on deserialized messages)
  if (messageRecord['type'] === 'tool') {
    return true;
  }

  // Check for getType method (deprecated but still used in some places)
  if (typeof messageRecord['getType'] === 'function') {
    return (messageRecord['getType'] as () => string)() === 'tool';
  }

  return false;
}

/**
 * Attempts to parse JSON content from a tool message.
 * Returns undefined if parsing fails.
 */
function parseToolContent(content: string): unknown | undefined {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Trims tool message content if a trimmer is registered for the tool.
 * Falls back to content-based detection when message.name is undefined
 * (common with messages created by `@ai-sdk/langchain` adapter).
 *
 * Handles both proper ToolMessage instances and deserialized plain objects.
 */
function trimToolMessage(message: ToolMessage): BaseMessage {
  // Access properties defensively to handle both ToolMessage and plain objects
  const messageRecord = message as unknown as Record<string, unknown>;
  const {
    content,
    name,
    tool_call_id: toolCallId,
  } = messageRecord as {
    content: unknown;
    name: string | undefined;
    tool_call_id: string;
  };

  // Only handle string content (JSON)
  if (typeof content !== 'string') {
    return message;
  }

  const parsed = parseToolContent(content);
  if (parsed === undefined) {
    return message;
  }

  // Try to find trimmer by message.name first, fall back to content detection
  const toolNameValue = name ?? detectToolNameFromContent(parsed);
  const trimmer = toolNameValue ? toolResultTrimmers[toolNameValue] : undefined;

  if (!trimmer) {
    return message;
  }

  const trimmed = trimmer(parsed);

  // Create a proper ToolMessage instance with trimmed content
  // This also rehydrates deserialized plain objects into proper instances
  return new ToolMessage({
    content: JSON.stringify(trimmed),
    // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
    tool_call_id: toolCallId,
    name: toolNameValue,
  });
}

/**
 * Middleware that trims tool call results before sending to the LLM.
 *
 * Uses the `wrapModelCall` hook to intercept model requests and trim
 * ToolMessage content based on registered trimmers for each tool.
 *
 * This helps reduce token usage by removing unnecessary data
 * from the message history that the LLM doesn't need to see again.
 *
 * Currently trims:
 * - test_model: Removes the `passed` count (can be inferred from total - failures.length)
 */
export const toolResultTrimmerMiddleware = createMiddleware({
  name: 'ToolResultTrimmer',

  async wrapModelCall(request, handler) {
    // Map through messages and trim ToolMessages
    const trimmedMessages = request.messages.map((message) => {
      if (isToolMessage(message)) {
        return trimToolMessage(message);
      }

      return message;
    });

    // Call the handler with trimmed messages
    return handler({
      ...request,
      messages: trimmedMessages,
    });
  },
});
