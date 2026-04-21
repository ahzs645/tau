import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { editTestsInputSchema, isRpcClientError } from '@taucad/chat';
import { assertRpcExecution, assertRpcSuccess, ToolError } from '@taucad/chat/utils';
import type { ChatTool, EditTestsInput, EditTestsOutput } from '@taucad/chat';
import { toolName, rpcName } from '@taucad/chat/constants';
import type { KernelProvider } from '@taucad/runtime';
import { AVAILABLE_CHECKS_COPY, renderCanonicalExample, testFileSchema } from '@taucad/testing';
import { getKernelConfig } from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.js';
import type { ChatRpcConfigurable } from '#api/tools/tool.types.js';

const testFile = 'test.json';

const defaultTestFile = JSON.stringify({}, null, 2);

/**
 * Build the kernel-aware definition for the `edit_tests` tool. The example
 * map keys (e.g. `main.scad` vs `main.ts` vs `main.kcl`) are derived from the
 * active kernel's file extension so the agent never sees TS-only paths on a
 * .scad / .kcl project.
 */
export const createEditTestsToolDefinition = (
  kernel: KernelProvider,
): { name: typeof toolName.editTests; description: string; schema: typeof editTestsInputSchema } => {
  const config = getKernelConfig(kernel);
  const extension = config.fileExtension;
  return {
    name: toolName.editTests,
    description: `Edit test.json to add, modify, or remove per-file test requirements.

test.json is a per-file map keyed by source file path. Each entry holds the
requirements that will be evaluated against THAT file's geometry only. Add or
update keys when introducing new files; do not delete other files' requirements.

Uses the same pattern as edit_file - specify edits with // ... existing code ... to represent unchanged sections.

Example:
${renderCanonicalExample(extension)}

${AVAILABLE_CHECKS_COPY}

The outer object MUST be keyed by source file path; any other shape (including a top-level "requirements" array) is rejected by post-write validation.

Use this tool BEFORE making model changes (TDD approach). Cover every geometry unit you care about — adding more tests is preferable to skipping coverage.

When NOT to use:
- NOT for editing any file other than \`test.json\` — use \`edit_file\` (or \`create_file\` for new files); \`edit_tests\` only modifies \`test.json\`.`,
    schema: editTestsInputSchema,
  } as const;
};

/**
 * Build the kernel-aware `edit_tests` tool. Behavior is identical across
 * kernels — only the description copy varies — but the factory keeps the
 * surface symmetric with `createTestModelTool`.
 */
export const createEditTestsTool = (
  kernel: KernelProvider,
): ChatTool<typeof editTestsInputSchema, EditTestsInput, EditTestsOutput, typeof toolName.editTests> => {
  const definition = createEditTestsToolDefinition(kernel);

  return tool(async (args, runtime: ToolRuntime) => {
    const { chatRpcService, fileEditService, thread_id: chatId } = runtime.configurable as ChatRpcConfigurable;
    const { toolCallId } = runtime;
    const { codeEdit } = args;

    const readResult = await chatRpcService.sendRpcRequest({
      chatId,
      toolCallId,
      rpcName: rpcName.readFile,
      args: { targetFile: testFile },
    });

    assertRpcExecution(readResult, toolName.editTests, toolCallId);

    let originalContent: string;
    if (isRpcClientError(readResult)) {
      if (readResult.errorCode === 'FILE_NOT_FOUND') {
        originalContent = defaultTestFile;
      } else {
        throw new ToolError({
          errorCode: 'TOOL_EXECUTION_ERROR',
          message: `Cannot read test.json: ${readResult.message}`,
          toolName: toolName.editTests,
          toolCallId,
        });
      }
    } else {
      originalContent = readResult.content === '' ? defaultTestFile : readResult.content;
    }

    const editResult = await fileEditService.applyFileEdit({
      targetFile: testFile,
      originalContent,
      codeEdit,
      instructions: 'Apply the test requirements edit to test.json',
    });

    if (!editResult.success) {
      throw new ToolError({
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `Failed to apply edit to test.json: ${editResult.error}`,
        toolName: toolName.editTests,
        toolCallId,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(editResult.editedContent);
    } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError);
      throw new ToolError({
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `Edited test.json is not valid JSON: ${message}`,
        toolName: toolName.editTests,
        toolCallId,
      });
    }

    const validation = testFileSchema.safeParse(parsed);
    if (!validation.success) {
      const issues = validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new ToolError({
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `Edited test.json does not match the per-file shape. Issues: ${issues}. Each top-level key must be a source file path; each value must be { "requirements": [...] }.`,
        toolName: toolName.editTests,
        toolCallId,
      });
    }

    const writeResult = await chatRpcService.sendRpcRequest({
      chatId,
      toolCallId,
      rpcName: rpcName.createFile,
      args: { targetFile: testFile, content: editResult.editedContent },
    });

    assertRpcSuccess(writeResult, {
      toolName: toolName.editTests,
      toolCallId,
      clientErrorMessage: 'Cannot save test.json',
    });

    const result: EditTestsOutput = {
      diffStats: {
        linesAdded: editResult.diffStats?.linesAdded ?? 0,
        linesRemoved: editResult.diffStats?.linesRemoved ?? 0,
        originalContent,
        modifiedContent: editResult.editedContent,
      },
    };
    return result;
  }, definition);
};
