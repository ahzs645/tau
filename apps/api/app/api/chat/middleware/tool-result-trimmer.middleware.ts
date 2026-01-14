import { createMiddleware } from 'langchain';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { toolName } from '@taucad/chat/constants';
import type { ImageAnalysisOutput, Observation } from '@taucad/chat';

/**
 * Type for a tool result trimmer function.
 * Takes the parsed tool result and returns a trimmed version.
 */
type ToolResultTrimmer<T = unknown> = (result: T) => T;

/**
 * Registry of tool result trimmers.
 * Each key is a tool name, and the value is a function that trims the result.
 */
const toolResultTrimmers: Record<string, ToolResultTrimmer> = {
  /**
   * Trims the image analysis result by removing the src field from observations.
   * This prevents significant token bloat from base64 image data in the message history.
   */
  [toolName.imageAnalysis](result: unknown): unknown {
    const typedResult = result as ImageAnalysisOutput;

    // Trim src from observations to reduce token usage
    const trimmedObservations: Observation[] = typedResult.observations.map((obs) => ({
      ...obs,
      src: '', // Remove the base64 image data
    }));

    return {
      ...typedResult,
      observations: trimmedObservations,
    };
  },
};

/**
 * Type guard to check if a message is a ToolMessage.
 */
function isToolMessage(message: BaseMessage): message is ToolMessage {
  return message instanceof ToolMessage;
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
 */
function trimToolMessage(message: ToolMessage): BaseMessage {
  const toolNameValue = message.name;

  // Check if we have a trimmer for this tool
  const trimmer = toolNameValue ? toolResultTrimmers[toolNameValue] : undefined;
  if (!trimmer) {
    return message;
  }

  // Handle string content (JSON)
  if (typeof message.content === 'string') {
    const parsed = parseToolContent(message.content);
    if (parsed === undefined) {
      return message;
    }

    const trimmed = trimmer(parsed);

    return new ToolMessage({
      ...message,
      content: JSON.stringify(trimmed),
    });
  }

  // For non-string content, return as-is
  return message;
}

/**
 * Middleware that trims tool call results before sending to the LLM.
 *
 * Uses the `wrapModelCall` hook to intercept model requests and trim
 * ToolMessage content based on registered trimmers for each tool.
 *
 * This helps reduce token usage by removing large data (like base64 images)
 * from the message history that the LLM doesn't need to see again.
 *
 * Currently trims:
 * - analyze_image: Removes the `src` field from observations
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
