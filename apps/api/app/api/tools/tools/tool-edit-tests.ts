import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { editTestsInputSchema, isToolExecutionError } from '@taucad/chat';
import type { EditTestsOutput } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import type { ChatToolsConfigurable } from '#api/tools/tool.types.js';

export const editTestsToolDefinition = {
  name: toolName.editTests,
  description: `Edit test.json to add, modify, or remove test requirements.

Uses the same pattern as edit_file - specify edits with // ... existing code ... to represent unchanged sections.

Example edit to add a new requirement:
{
  "requirements": [
    // ... existing code ...
    {
      "id": "req_hole_visible",
      "description": "Circular hole visible through the sphere",
      "type": "visual"
    }
  ]
}

**Requirement guidelines:**
- Describe VISIBLE OUTCOMES, not CAD operations
- Do NOT specify views (FRONT, TOP, etc.) - all 6 orthographic views are analyzed automatically
- Good: "Circular hole visible through sphere", "Smooth curved surface"
- Bad: "TOP view shows hole", "Boolean difference applied"

Use this tool BEFORE making model changes (TDD approach).`,
  schema: editTestsInputSchema,
} as const;

const testFile = 'test.json';

// Default test.json content when file doesn't exist
const defaultTestFile = JSON.stringify(
  {
    requirements: [],
  },
  null,
  2,
);

export const editTestsTool = tool(
  async (args, runtime: ToolRuntime) => {
    const { chatToolsService, fileEditService, thread_id: chatId } = runtime.configurable as ChatToolsConfigurable;
    const { toolCallId } = runtime;
    const { codeEdit } = args;

    // Step 1: Read the current test.json content via WebSocket
    const readResult = await chatToolsService.sendToolCallRequest(chatId, toolCallId, toolName.readFile, {
      targetFile: testFile,
    });

    // Return error objects directly to the LLM
    if (isToolExecutionError(readResult)) {
      return readResult;
    }

    // If file doesn't exist, use default content
    const originalContent =
      readResult.content.startsWith('Error reading file:') || readResult.content === ''
        ? defaultTestFile
        : readResult.content;

    // Step 2: Apply the edit using FileEditService (Morph fast-apply)
    const editResult = await fileEditService.applyFileEdit({
      targetFile: testFile,
      originalContent,
      codeEdit,
      instructions: 'Apply the test requirements edit to test.json',
    });

    if (!editResult.success || !editResult.editedContent) {
      const result: EditTestsOutput = {
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
      targetFile: testFile,
      content: editResult.editedContent,
    });

    // Return error objects directly to the LLM
    if (isToolExecutionError(writeResult)) {
      return writeResult;
    }

    // Return the result with diff stats
    const result: EditTestsOutput = {
      success: true,
      diffStats: {
        linesAdded: editResult.diffStats?.linesAdded ?? 0,
        linesRemoved: editResult.diffStats?.linesRemoved ?? 0,
        originalContent,
        modifiedContent: editResult.editedContent,
      },
    };
    return result;
  },
  editTestsToolDefinition,
);
