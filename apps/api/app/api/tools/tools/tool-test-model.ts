import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { testModelInputSchema, testFileSchema, isRpcClientError } from '@taucad/chat';
import { assertRpcExecution, assertRpcSuccess } from '@taucad/chat/utils';
import type { ChatTool, TestModelInput, TestModelOutput, VisualTestRequirement } from '@taucad/chat';
import { rpcName, toolName } from '@taucad/chat/constants';
import type { ChatRpcConfigurable } from '#api/tools/tool.types.js';

export const testModelToolDefinition = {
  name: toolName.testModel,
  description: `Run all tests from test.json against the current 3D model.

Captures all 6 orthographic views and evaluates visual requirements across all views in a single analysis pass.

Returns:
- failures: Array of failed tests with actionable feedback (reason + suggestion)
- passed: Number of tests that passed
- total: Total number of tests run

If failures is empty, all tests passed.

Note: Reads requirements from test.json. Use edit_tests to add/modify requirements first.`,
  schema: testModelInputSchema,
} as const;

export const testModelTool: ChatTool<
  typeof testModelInputSchema,
  TestModelInput,
  TestModelOutput,
  typeof toolName.testModel
> = tool(async (_input, runtime: ToolRuntime) => {
  const { chatRpcService, analysisService, thread_id: chatId } = runtime.configurable as ChatRpcConfigurable;
  const { toolCallId } = runtime;

  // Step 1: Read test.json to get requirements
  const testFileContent = await chatRpcService.sendRpcRequest(chatId, toolCallId, rpcName.readFile, {
    targetFile: 'test.json',
  });

  // Assert infrastructure success - throws ToolError for timeout, disconnect, validation
  assertRpcExecution(testFileContent, toolName.testModel, toolCallId);

  // Handle client errors (file not found) gracefully - return as test failure, not tool error
  if (isRpcClientError(testFileContent)) {
    const result: TestModelOutput = {
      failures: [
        {
          id: 'missing_test_file',
          requirement: 'test.json file must exist',
          reason: 'No test.json file found in project root',
          suggestion: 'Use edit_tests to create test.json with requirements before running tests',
        },
      ],
      passes: [],
      passed: 0,
      total: 0,
    };

    return result;
  }

  // Check if test.json is empty
  if (testFileContent.content === '') {
    const result: TestModelOutput = {
      failures: [
        {
          id: 'empty_test_file',
          requirement: 'test.json file must have content',
          reason: 'test.json file is empty',
          suggestion: 'Use edit_tests to add requirements to test.json',
        },
      ],
      passes: [],
      passed: 0,
      total: 0,
    };

    return result;
  }

  // Parse test.json
  let testFile;
  try {
    const parsed = JSON.parse(testFileContent.content) as unknown;
    testFile = testFileSchema.parse(parsed);
  } catch {
    const result: TestModelOutput = {
      failures: [
        {
          id: 'invalid_test_file',
          requirement: 'test.json must be valid JSON with correct schema',
          reason: 'Failed to parse test.json - invalid format',
          suggestion: 'Ensure test.json has valid JSON with a "requirements" array',
        },
      ],
      passes: [],
      passed: 0,
      total: 0,
    };

    return result;
  }

  // Filter to visual requirements only (measurement tests not yet implemented)
  const visualRequirements = testFile.requirements.filter(
    (request): request is VisualTestRequirement => request.type === 'visual',
  );

  // Count non-visual requirements that are not yet supported
  const nonVisualRequirements = testFile.requirements.filter((request) => request.type !== 'visual');

  if (visualRequirements.length === 0) {
    // If there are non-visual requirements, report them as unsupported errors
    if (nonVisualRequirements.length > 0) {
      const result: TestModelOutput = {
        failures: nonVisualRequirements.map((request) => ({
          id: request.id,
          requirement: request.description,
          reason: `Requirement type '${request.type}' is not yet supported`,
          suggestion:
            'Currently only visual requirements are supported. Consider converting this to a visual requirement or wait for measurement test support.',
        })),
        passes: [],
        passed: 0,
        total: nonVisualRequirements.length,
      };

      return result;
    }

    // No requirements at all
    const result: TestModelOutput = {
      failures: [
        {
          id: 'no_requirements',
          requirement: 'test.json must contain at least one requirement',
          reason: 'No requirements found in test.json',
          suggestion: 'Use edit_tests to add visual requirements to test.json',
        },
      ],
      passes: [],
      passed: 0,
      total: 0,
    };

    return result;
  }

  // Step 2: Capture observations from the frontend via RPC
  const captureResult = await chatRpcService.sendRpcRequest(chatId, toolCallId, rpcName.captureObservations, {});

  // Assert RPC success - throws ToolError for any infrastructure or client error
  assertRpcSuccess(captureResult, toolName.testModel, toolCallId, 'Failed to capture observations');

  const { observations } = captureResult;

  // Step 3: Run visual tests using AnalysisService (single multi-view LLM call)
  const result = await analysisService.runVisualTests(observations, visualRequirements);

  return result;
}, testModelToolDefinition);
