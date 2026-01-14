import type { DynamicStructuredTool, ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { editFileInputSchema } from '@taucad/chat';
import type { EditFileInput, EditFileOutput, ReadFileInput, ReadFileOutput, CreateFileInput } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import type { JSONSchema } from '@langchain/core/utils/json_schema';
import type { ChatToolsConfigurable } from '#api/tools/tool.types.js';

const editFileJsonSchema = z.toJSONSchema(editFileInputSchema);

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
  schema: editFileJsonSchema,
} as const;

export const editFileTool: DynamicStructuredTool<JSONSchema, EditFileOutput, EditFileInput, EditFileOutput> = tool(
  async (input, runtime: ToolRuntime) => {
    const args = input as EditFileInput;
    const { chatToolsService, fileEditService, thread_id: chatId } = runtime.configurable as ChatToolsConfigurable;
    const { toolCallId } = runtime;
    const { targetFile, codeEdit } = args;

    // Step 1: Read the original file content via WebSocket
    // The frontend returns raw content without line numbers
    const readResult = (await chatToolsService.sendToolCallRequest(chatId, toolCallId, toolName.readFile, {
      targetFile,
    } satisfies ReadFileInput)) as ReadFileOutput;

    // Check if read failed
    if (readResult.content.startsWith('Error reading file:')) {
      return {
        success: false,
        diffStats: {
          linesAdded: 0,
          linesRemoved: 0,
          originalContent: '',
          modifiedContent: '',
        },
      };
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
      return {
        success: false,
        diffStats: {
          linesAdded: 0,
          linesRemoved: 0,
          originalContent,
          modifiedContent: originalContent,
        },
      };
    }

    // Step 3: Write the edited content back via WebSocket
    await chatToolsService.sendToolCallRequest(chatId, toolCallId, toolName.createFile, {
      targetFile,
      content: editResult.editedContent,
    } satisfies CreateFileInput);

    // Return the result with diff stats
    return {
      success: true,
      diffStats: {
        linesAdded: editResult.diffStats?.linesAdded ?? 0,
        linesRemoved: editResult.diffStats?.linesRemoved ?? 0,
        originalContent,
        modifiedContent: editResult.editedContent,
      },
    };
  },
  editFileToolDefinition,
);
