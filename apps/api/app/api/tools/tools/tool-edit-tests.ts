import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { editTestsInputSchema, isRpcClientError, isRpcExecutionError } from '@taucad/chat';
import { rpcErrorToToolError } from '@taucad/chat/utils';
import type { ChatTool, EditTestsInput, EditTestsOutput, ToolExecutionError } from '@taucad/chat';
import { rpcName, toolName } from '@taucad/chat/constants';
import type { ChatRpcConfigurable } from '#api/tools/tool.types.js';

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

export const editTestsTool: ChatTool<
  typeof editTestsInputSchema,
  EditTestsInput,
  EditTestsOutput,
  typeof toolName.editTests
> = tool(async (args, runtime: ToolRuntime) => {
  const { chatRpcService, fileEditService, thread_id: chatId } = runtime.configurable as ChatRpcConfigurable;
  const { toolCallId } = runtime;
  const { codeEdit } = args;

  // Step 1: Read the current test.json content via RPC
  const readResult = await chatRpcService.sendRpcRequest(chatId, toolCallId, rpcName.readFile, {
    targetFile: testFile,
  });

  // Handle RPC infrastructure errors (timeout, disconnect, validation)
  if (isRpcExecutionError(readResult)) {
    return rpcErrorToToolError(readResult, toolName.editTests, toolCallId);
  }

  // Handle RPC client errors - only use default for "file not found", propagate other errors
  let originalContent: string;
  if (isRpcClientError(readResult)) {
    if (readResult.errorCode === 'FILE_NOT_FOUND') {
      // File doesn't exist yet, use default content
      originalContent = defaultTestFile;
    } else {
      // Other errors (permissions, I/O, etc.) should be propagated
      const error: ToolExecutionError = {
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `Cannot read test.json: ${readResult.message}`,
        toolName: toolName.editTests,
        toolCallId,
      };
      return error;
    }
  } else {
    originalContent = readResult.content === '' ? defaultTestFile : readResult.content;
  }

  // Step 2: Apply the edit using FileEditService
  const editResult = await fileEditService.applyFileEdit({
    targetFile: testFile,
    originalContent,
    codeEdit,
    instructions: 'Apply the test requirements edit to test.json',
  });

  if (!editResult.success) {
    const error: ToolExecutionError = {
      errorCode: 'TOOL_EXECUTION_ERROR',
      message: `Failed to apply edit to test.json: ${editResult.error}`,
      toolName: toolName.editTests,
      toolCallId,
    };
    return error;
  }

  // Step 3: Write the edited content back via RPC
  const writeResult = await chatRpcService.sendRpcRequest(chatId, toolCallId, rpcName.createFile, {
    targetFile: testFile,
    content: editResult.editedContent,
  });

  // Handle RPC infrastructure errors (timeout, disconnect, validation)
  if (isRpcExecutionError(writeResult)) {
    return rpcErrorToToolError(writeResult, toolName.editTests, toolCallId);
  }

  // Handle RPC client errors (permission denied, etc.)
  if (isRpcClientError(writeResult)) {
    const error: ToolExecutionError = {
      errorCode: 'TOOL_EXECUTION_ERROR',
      message: `Cannot save test.json: ${writeResult.message}`,
      toolName: toolName.editTests,
      toolCallId,
    };
    return error;
  }

  const result: EditTestsOutput = {
    diffStats: {
      linesAdded: editResult.diffStats?.linesAdded ?? 0,
      linesRemoved: editResult.diffStats?.linesRemoved ?? 0,
      originalContent,
      modifiedContent: editResult.editedContent,
    },
  };
  return result;
}, editTestsToolDefinition);
