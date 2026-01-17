import { createMiddleware } from 'langchain';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage, ToolCall } from '@langchain/core/messages';
import { toolName } from '@taucad/chat/constants';
import type {
  TestModelOutput,
  CreateFileOutput,
  EditFileOutput,
  GetKernelResultOutput,
  CaptureObservationsOutput,
  ReadFileOutput,
} from '@taucad/chat';

// =============================================================================
// Configuration
// =============================================================================

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

// =============================================================================
// Content Shape Detectors
// =============================================================================
// These functions detect tool output shapes when message.name is undefined
// (common with messages created by @ai-sdk/langchain adapter).
// Order matters: more specific detectors should be checked first.

/**
 * Helper to check if value is a non-null object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Checks if content has the shape of TestModelOutput.
 * Unique: has failures array + total count (no other tool has this combination).
 */
function isTestModelShape(content: unknown): boolean {
  if (!isObject(content)) {
    return false;
  }

  return Array.isArray(content['failures']) && typeof content['total'] === 'number';
}

/**
 * Checks if content has the shape of CreateFileOutput or EditFileOutput.
 * Both have success + diffStats with linesAdded/linesRemoved.
 * We use the same detector for both since they have identical shapes.
 */
function isDiffStatsShape(content: unknown): boolean {
  if (!isObject(content)) {
    return false;
  }

  if (typeof content['success'] !== 'boolean') {
    return false;
  }

  const { diffStats } = content;
  if (!isObject(diffStats)) {
    return false;
  }

  return typeof diffStats['linesAdded'] === 'number' && typeof diffStats['linesRemoved'] === 'number';
}

/**
 * Checks if content has the shape of GetKernelResultOutput.
 * Unique: has status enum ('ready' | 'error' | 'pending') + optional kernelIssues array.
 */
function isGetKernelResultShape(content: unknown): boolean {
  if (!isObject(content)) {
    return false;
  }

  const { status, kernelIssues } = content;
  if (status !== 'ready' && status !== 'error' && status !== 'pending') {
    return false;
  }

  // KernelIssues is optional, but if present must be an array
  if (kernelIssues !== undefined && !Array.isArray(kernelIssues)) {
    return false;
  }

  return true;
}

/**
 * Checks if content has the shape of CaptureObservationsOutput.
 * Unique: has observations array where each item has id + side.
 */
function isCaptureObservationsShape(content: unknown): boolean {
  if (!isObject(content)) {
    return false;
  }

  const { observations } = content;
  if (!Array.isArray(observations)) {
    return false;
  }

  // Check that at least one observation has the expected shape
  // (empty array is valid but we can't distinguish it)
  if (observations.length === 0) {
    return true; // Could be empty observations, but matches shape
  }

  const firstObs: unknown = observations[0];
  if (!isObject(firstObs)) {
    return false;
  }

  return typeof firstObs['id'] === 'string' && typeof firstObs['side'] === 'string';
}

/**
 * Checks if content has the shape of ReadFileOutput.
 * Unique: has content string + totalLines number.
 */
function isReadFileShape(content: unknown): boolean {
  if (!isObject(content)) {
    return false;
  }

  return typeof content['content'] === 'string' && typeof content['totalLines'] === 'number';
}

/**
 * Checks if content has the shape of ListDirectoryOutput.
 * Unique: has entries array + path string.
 */
function isListDirectoryShape(content: unknown): boolean {
  if (!isObject(content)) {
    return false;
  }

  return Array.isArray(content['entries']) && typeof content['path'] === 'string';
}

/**
 * Checks if content has the shape of GrepOutput.
 * Unique: has matches array + totalMatches number.
 */
function isGrepShape(content: unknown): boolean {
  if (!isObject(content)) {
    return false;
  }

  return Array.isArray(content['matches']) && typeof content['totalMatches'] === 'number';
}

/**
 * Checks if content has the shape of GlobSearchOutput.
 * Unique: has files array + totalFiles number.
 */
function isGlobSearchShape(content: unknown): boolean {
  if (!isObject(content)) {
    return false;
  }

  return Array.isArray(content['files']) && typeof content['totalFiles'] === 'number';
}

/**
 * Registry of content shape detectors.
 * Maps tool names to functions that detect if content matches that tool's output shape.
 * Used as a fallback when message.name is undefined.
 *
 * Note: create_file and edit_file share the same detector (isDiffStatsShape) since
 * they have identical output shapes. The trimmer for both is also functionally identical.
 */
const contentShapeDetectors: Record<string, ContentShapeDetector> = {
  [toolName.testModel]: isTestModelShape,
  [toolName.createFile]: isDiffStatsShape,
  [toolName.editFile]: isDiffStatsShape,
  [toolName.getKernelResult]: isGetKernelResultShape,
  [toolName.captureObservations]: isCaptureObservationsShape,
  [toolName.readFile]: isReadFileShape,
  [toolName.listDirectory]: isListDirectoryShape,
  [toolName.grep]: isGrepShape,
  [toolName.globSearch]: isGlobSearchShape,
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
 *
 * These trimmers remove redundant data that the LLM doesn't need to see again,
 * significantly reducing token usage in long conversations.
 */
const toolResultTrimmers: Record<string, ToolResultTrimmer> = {
  /**
   * Trims the test model result by removing the 'passed' count.
   * The LLM can infer it from total - failures.length if needed.
   */
  [toolName.testModel](result: unknown): unknown {
    const typedResult = result as TestModelOutput;

    // Remove 'passed' count - LLM can infer from total - failures.length
    return {
      failures: typedResult.failures,
      total: typedResult.total,
    };
  },

  /**
   * Trims create_file result by removing full file content from diffStats.
   * The LLM just wrote this content, so it doesn't need to see it again.
   * Keeps only success status and line change counts.
   */
  [toolName.createFile](result: unknown): unknown {
    // Use loose type to safely check for diffStats presence (can be missing on error)
    const record = result as Record<string, unknown>;
    const { diffStats } = record;
    if (!isObject(diffStats)) {
      return result;
    }

    const typedResult = result as CreateFileOutput;

    return {
      success: typedResult.success,
      ...(typedResult.message ? { message: typedResult.message } : {}),
      diffStats: {
        linesAdded: typedResult.diffStats.linesAdded,
        linesRemoved: typedResult.diffStats.linesRemoved,
        // REMOVED: originalContent, modifiedContent - LLM just wrote this
      },
    };
  },

  /**
   * Trims edit_file result by removing full file content from diffStats.
   * The LLM just wrote this content, so it doesn't need to see it again.
   * Keeps only success status and line change counts.
   */
  [toolName.editFile](result: unknown): unknown {
    // Use loose type to safely check for diffStats presence (can be missing on error)
    const record = result as Record<string, unknown>;
    const { diffStats } = record;
    if (!isObject(diffStats)) {
      return result;
    }

    const typedResult = result as EditFileOutput;

    return {
      success: typedResult.success,
      diffStats: {
        linesAdded: typedResult.diffStats.linesAdded,
        linesRemoved: typedResult.diffStats.linesRemoved,
        // REMOVED: originalContent, modifiedContent - LLM just wrote this
      },
    };
  },

  /**
   * Trims get_kernel_result by removing verbose stack traces.
   * The message and location are sufficient for debugging.
   */
  [toolName.getKernelResult](result: unknown): unknown {
    const typedResult = result as GetKernelResultOutput;

    return {
      status: typedResult.status,
      ...(typedResult.kernelIssues
        ? {
            kernelIssues: typedResult.kernelIssues.map((issue) => ({
              message: issue.message,
              ...(issue.location ? { location: issue.location } : {}),
              severity: issue.severity,
              ...(issue.type ? { type: issue.type } : {}),
              // Keep stack and stackFrames - important for LLM to debug error origins
              ...(issue.stack ? { stack: issue.stack } : {}),
              ...(issue.stackFrames ? { stackFrames: issue.stackFrames } : {}),
            })),
          }
        : {}),
    };
  },

  /**
   * Trims capture_observations by removing base64 image data.
   * The images have already been processed/displayed to the user.
   * Keeps only metadata (id, side) for reference.
   */
  [toolName.captureObservations](result: unknown): unknown {
    const typedResult = result as CaptureObservationsOutput;

    return {
      observations: typedResult.observations.map((obs) => ({
        id: obs.id,
        side: obs.side,
        // REMOVED: src - base64 image data, already processed
      })),
    };
  },
};

// =============================================================================
// Stale File Detection
// =============================================================================
// Track which files have been modified (create_file/edit_file) to invalidate
// older read_file results for those files.

/**
 * Type for tracking file modifications.
 * Maps file path to the earliest message index where it was modified.
 */
type FileModificationMap = Map<string, number>;

/**
 * Type guard to check if a message is an AIMessage with tool_calls.
 */
function isAiMessageWithToolCalls(message: BaseMessage): message is AIMessage & { tool_calls: ToolCall[] } {
  if (!AIMessage.isInstance(message)) {
    return false;
  }

  const { tool_calls: toolCalls } = message as AIMessage;

  return Array.isArray(toolCalls) && toolCalls.length > 0;
}

/**
 * Extracts the targetFile from a tool call's args if present.
 */
function getTargetFileFromToolCall(toolCall: ToolCall): string | undefined {
  const args = toolCall.args as Record<string, unknown>;
  const { targetFile } = args;

  return typeof targetFile === 'string' ? targetFile : undefined;
}

/**
 * Extracts modified file paths from AIMessage tool_calls.
 * Looks for create_file and edit_file tool calls and extracts the targetFile.
 */
function extractModifiedFiles(message: AIMessage & { tool_calls: ToolCall[] }): string[] {
  const modifiedFiles: string[] = [];

  for (const toolCall of message.tool_calls) {
    if (toolCall.name === toolName.createFile || toolCall.name === toolName.editFile) {
      const targetFile = getTargetFileFromToolCall(toolCall);
      if (targetFile) {
        modifiedFiles.push(targetFile);
      }
    }
  }

  return modifiedFiles;
}

/**
 * Builds a map of file paths to the earliest message index where they were modified.
 * This is used to detect stale read_file results.
 */
function buildFileModificationMap(messages: BaseMessage[]): FileModificationMap {
  const modificationMap: FileModificationMap = new Map();

  for (const [i, message] of messages.entries()) {
    if (isAiMessageWithToolCalls(message)) {
      const modifiedFiles = extractModifiedFiles(message);
      for (const file of modifiedFiles) {
        // Only record the earliest modification
        if (!modificationMap.has(file)) {
          modificationMap.set(file, i);
        }
      }
    }
  }

  return modificationMap;
}

/**
 * Finds the targetFile from a read_file tool call by its ID.
 */
function findReadFileTarget(toolCalls: ToolCall[], toolCallId: string): string | undefined {
  for (const toolCall of toolCalls) {
    if (toolCall.id === toolCallId && toolCall.name === toolName.readFile) {
      return getTargetFileFromToolCall(toolCall);
    }
  }

  return undefined;
}

/**
 * Extracts the targetFile from a read_file tool call ID by finding the corresponding
 * AIMessage with the tool call.
 */
function getReadFileTargetFromToolCallId(messages: BaseMessage[], toolCallId: string): string | undefined {
  for (const message of messages) {
    if (isAiMessageWithToolCalls(message)) {
      const targetFile = findReadFileTarget(message.tool_calls, toolCallId);
      if (targetFile) {
        return targetFile;
      }
    }
  }

  return undefined;
}

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
 * Context passed to trimToolMessage for stale file detection.
 */
type TrimContext = {
  /** If true, the file was modified after this read (for read_file only) */
  isStaleRead: boolean;
};

/**
 * Trims tool message content if a trimmer is registered for the tool.
 * Falls back to content-based detection when message.name is undefined
 * (common with messages created by `@ai-sdk/langchain` adapter).
 *
 * Handles both proper ToolMessage instances and deserialized plain objects.
 *
 * @param message - The tool message to trim
 * @param context - Trimming context (stale status)
 */
function trimToolMessage(message: ToolMessage, context: TrimContext): BaseMessage {
  const { isStaleRead } = context;
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

  // Apply immediate trimmer (if available)
  const trimmer = toolNameValue ? toolResultTrimmers[toolNameValue] : undefined;
  let trimmed = trimmer ? trimmer(parsed) : parsed;

  // Handle stale read_file results (file was modified after this read)
  if (isStaleRead && toolNameValue === toolName.readFile) {
    const typedResult = parsed as ReadFileOutput;
    trimmed = {
      content: '[File was modified after this read - content is stale]',
      totalLines: typedResult.totalLines,
      ...(typedResult.startLine ? { startLine: typedResult.startLine } : {}),
    };
  }

  // If no trimming was done, return original message
  if (trimmed === parsed) {
    return message;
  }

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
 * Trimming is applied uniformly to all messages to ensure stable content
 * for Anthropic prompt caching. Consistent content enables cache hits
 * across conversation turns.
 *
 * Trimming (all messages):
 * - test_model: Removes the `passed` count (can be inferred from total - failures.length)
 * - create_file: Removes `diffStats.originalContent` and `diffStats.modifiedContent`
 * - edit_file: Removes `diffStats.originalContent` and `diffStats.modifiedContent`
 * - get_kernel_result: Keeps essential error info for debugging
 * - capture_observations: Removes base64 `src` image data from observations
 *
 * Stale detection:
 * - read_file: If file was modified by create_file/edit_file after this read,
 *   content is replaced with "[File was modified after this read - content is stale]"
 */
export const toolResultTrimmerMiddleware = createMiddleware({
  name: 'ToolResultTrimmer',

  async wrapModelCall(request, handler) {
    const { messages } = request;

    // Build file modification map for stale detection
    const fileModificationMap = buildFileModificationMap(messages);

    // Trim messages with stale-aware trimming
    const trimmedMessages = messages.map((message, index) => {
      if (isToolMessage(message)) {
        // Check if this is a stale read_file result
        let isStaleRead = false;
        const messageRecord = message as unknown as Record<string, unknown>;
        const {
          tool_call_id: toolCallId,
          name: messageName,
          content,
        } = messageRecord as {
          tool_call_id: string | undefined;
          name: string | undefined;
          content: unknown;
        };
        const isReadFileTool =
          messageName === toolName.readFile ||
          (typeof content === 'string' && isReadFileShape(parseToolContent(content) ?? {}));

        if (isReadFileTool && toolCallId) {
          // Find the targetFile from the corresponding tool call
          const targetFile = getReadFileTargetFromToolCallId(messages, toolCallId);
          if (targetFile) {
            const modificationIndex = fileModificationMap.get(targetFile);
            // If the file was modified after this read, mark it as stale
            if (modificationIndex !== undefined && modificationIndex > index) {
              isStaleRead = true;
            }
          }
        }

        return trimToolMessage(message, { isStaleRead });
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
