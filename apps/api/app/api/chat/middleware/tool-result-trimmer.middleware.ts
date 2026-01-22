import { createMiddleware } from 'langchain';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { PartialDeep } from 'type-fest';
import { toolName } from '@taucad/chat/constants';
import type { ToolOutputRegistry } from '@taucad/chat';

// =============================================================================
// Configuration
// =============================================================================

/**
 * Type for a content shape detector function.
 * Returns true if the parsed content matches the expected shape for a tool.
 */
type ContentShapeDetector = (content: unknown) => boolean;

/**
 * Creates a type-safe trimmer function for a specific tool.
 * The inner function receives properly typed input based on ToolOutputRegistry,
 * while the returned function accepts unknown for use in the registry.
 *
 * The return type uses PartialDeep to allow returning a subset of the original
 * structure with some properties removed (e.g., removing large content fields
 * to reduce token usage). This provides type safety while allowing any depth
 * of the structure to be partially returned, including array elements.
 *
 * @param _toolName - The tool name (used only for type inference)
 * @param fn - The trimmer function with typed input, returns a trimmed structure
 * @returns A function that accepts unknown and returns unknown
 */
function createTrimmer<T extends keyof ToolOutputRegistry>(
  _toolName: T,
  fn: (result: ToolOutputRegistry[T]) => PartialDeep<ToolOutputRegistry[T], { recurseIntoArrays: true }>,
): (result: unknown) => unknown {
  return fn as (result: unknown) => unknown;
}

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
 *
 * Uses createTrimmer for type-safe trimmer definitions - the inner function
 * receives properly typed input based on ToolOutputRegistry.
 *
 * Note: Tool results are validated upstream via ChatToolsService (using Zod schemas
 * from clientToolSchemasRegistry) before being stored in messages. Error results
 * (ToolExecutionError, ToolValidationError) are serialized differently and won't
 * match the content shape detectors, so trimmers won't be called for them.
 */
const toolResultTrimmers: Record<string, (result: unknown) => unknown> = {
  /**
   * Trims the test model result by removing the 'passed' count.
   * The LLM can infer it from total - failures.length if needed.
   */
  [toolName.testModel]: createTrimmer(toolName.testModel, (result) => ({
    failures: result.failures,
    total: result.total,
    // REMOVED: passed, passes - LLM can infer from total - failures.length
  })),

  /**
   * Trims create_file result by removing full file content from diffStats.
   * The LLM just wrote this content, so it doesn't need to see it again.
   * Keeps only success status and line change counts.
   */
  [toolName.createFile]: createTrimmer(toolName.createFile, (result) => ({
    success: result.success,
    ...(result.message ? { message: result.message } : {}),
    diffStats: {
      linesAdded: result.diffStats.linesAdded,
      linesRemoved: result.diffStats.linesRemoved,
      // REMOVED: originalContent, modifiedContent - LLM just wrote this
    },
  })),

  /**
   * Trims edit_file result by removing full file content from diffStats.
   * The LLM just wrote this content, so it doesn't need to see it again.
   * Keeps only success status and line change counts.
   */
  [toolName.editFile]: createTrimmer(toolName.editFile, (result) => ({
    success: result.success,
    diffStats: {
      linesAdded: result.diffStats.linesAdded,
      linesRemoved: result.diffStats.linesRemoved,
      // REMOVED: originalContent, modifiedContent - LLM just wrote this
    },
  })),

  /**
   * Trims get_kernel_result by removing verbose stack traces.
   * The message and location are sufficient for debugging.
   */
  [toolName.getKernelResult]: createTrimmer(toolName.getKernelResult, (result) => ({
    status: result.status,
    ...(result.kernelIssues
      ? {
          kernelIssues: result.kernelIssues.map((issue) => ({
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
  })),

  /**
   * Trims capture_observations by removing base64 image data.
   * The images have already been processed/displayed to the user.
   * Keeps only metadata (id, side) for reference.
   */
  [toolName.captureObservations]: createTrimmer(toolName.captureObservations, (result) => ({
    observations: result.observations.map((obs) => ({
      id: obs.id,
      side: obs.side,
      // REMOVED: src - base64 image data, already processed
    })),
  })),
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
 *
 * @param message - The tool message to trim
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

  // Apply trimmer (if available)
  const trimmer = toolNameValue ? toolResultTrimmers[toolNameValue] : undefined;
  const trimmed = trimmer ? trimmer(parsed) : parsed;

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
 */
export const toolResultTrimmerMiddleware = createMiddleware({
  name: 'ToolResultTrimmer',

  async wrapModelCall(request, handler) {
    const { messages } = request;

    // Trim tool messages to reduce token usage
    const trimmedMessages = messages.map((message) => {
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
