import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { editFileInputSchema } from '@taucad/chat';
import { isToolExecutionError } from '@taucad/chat/utils';
import type { ChatTool, EditFileInput, EditFileOutput } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import type { ChatToolsConfigurable } from '#api/tools/tool.types.js';

export const editFileToolDefinition = {
  name: toolName.editFile,
  description: `Use this tool to propose an edit to an existing file.

This will be read by a less intelligent model, which will quickly apply the edit. You should make it clear what the edit is, while also minimizing the unchanged code you write.

When writing the edit, you should specify each edit in sequence, with the special comment // ... existing code ... to represent unchanged code in between edited lines.

For example:

// ... existing code ...
FIRST_EDIT
// ... existing code ...
SECOND_EDIT
// ... existing code ...
THIRD_EDIT
// ... existing code ...

You should bias towards repeating as few lines of the original file as possible to convey the change.
Each edit should contain sufficient context of unchanged lines around the code you're editing to resolve ambiguity.
If you plan on deleting a section, you must provide surrounding context to indicate the deletion.
DO NOT omit spans of pre-existing code without using the // ... existing code ... comment to indicate its absence.`,
  schema: editFileInputSchema,
} as const;

export const editFileTool: ChatTool<
  typeof editFileInputSchema,
  EditFileInput,
  EditFileOutput,
  typeof toolName.editFile
> = tool(async (args, runtime: ToolRuntime) => {
  const { chatToolsService, fileEditService, thread_id: chatId } = runtime.configurable as ChatToolsConfigurable;
  const { toolCallId } = runtime;
  const { targetFile, codeEdit } = args;

  // Step 1: Read the original file content via WebSocket
  // The frontend returns raw content without line numbers
  const readResult = await chatToolsService.sendToolCallRequest(chatId, toolCallId, toolName.readFile, {
    targetFile,
  });

  // Return error objects directly to the LLM
  if (isToolExecutionError(readResult)) {
    return readResult;
  }

  // Check if read failed (file doesn't exist)
  if (readResult.content.startsWith('Error reading file:')) {
    const result: EditFileOutput = {
      success: false,
      diffStats: {
        linesAdded: 0,
        linesRemoved: 0,
        originalContent: '',
        modifiedContent: '',
      },
    };
    return result;
  }

  // Frontend sends raw content (no line numbers)
  const originalContent = readResult.content;

  // Step 2: Apply the edit using FileEditService
  const editResult = await fileEditService.applyFileEdit({
    targetFile,
    originalContent,
    codeEdit,
    instructions: 'Apply the code edit',
  });

  if (!editResult.success || !editResult.editedContent) {
    const result: EditFileOutput = {
      success: false,
      diffStats: {
        linesAdded: 0,
        linesRemoved: 0,
        originalContent,
        modifiedContent: originalContent,
      },
    };
    return result;
  }

  // Step 3: Write the edited content back via WebSocket
  const writeResult = await chatToolsService.sendToolCallRequest(chatId, toolCallId, toolName.createFile, {
    targetFile,
    content: editResult.editedContent,
  });

  // Return error objects directly to the LLM
  if (isToolExecutionError(writeResult)) {
    return writeResult;
  }

  // Return the result with diff stats
  const result: EditFileOutput = {
    success: true,
    diffStats: {
      linesAdded: editResult.diffStats?.linesAdded ?? 0,
      linesRemoved: editResult.diffStats?.linesRemoved ?? 0,
      originalContent,
      modifiedContent: editResult.editedContent,
    },
  };
  return result;
}, editFileToolDefinition);
