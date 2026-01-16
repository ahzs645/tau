import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  testModelInputSchema,
  testFileSchema,
  type TestModelOutput,
  type CaptureObservationsOutput,
  type VisualTestRequirement,
} from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import type { ChatToolsConfigurable } from '#api/tools/tool.types.js';

const testModelJsonSchema = z.toJSONSchema(testModelInputSchema);

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
  schema: testModelJsonSchema,
} as const;

export const testModelTool = tool(async (_input, runtime: ToolRuntime) => {
  const { chatToolsService, analysisService, thread_id: chatId } = runtime.configurable as ChatToolsConfigurable;
  const { toolCallId } = runtime;

  // Step 1: Read test.json to get requirements
  const testFileContent = (await chatToolsService.sendToolCallRequest(chatId, toolCallId, toolName.readFile, {
    targetFile: 'test.json',
  })) as { content: string };

  // Check if test.json exists
  if (testFileContent.content.startsWith('Error reading file:') || testFileContent.content === '') {
    const result: TestModelOutput = {
      failures: [
        {
          id: 'missing_test_file',
          requirement: 'test.json file must exist',
          reason: 'No test.json file found in project root',
          suggestion: 'Use edit_tests to create test.json with requirements before running tests',
        },
      ],
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
      passed: 0,
      total: 0,
    };

    return result;
  }

  // Filter to visual requirements only (measurement tests not yet implemented)
  const visualRequirements = testFile.requirements.filter(
    (req): req is VisualTestRequirement => req.type === 'visual',
  );

  if (visualRequirements.length === 0) {
    const result: TestModelOutput = {
      failures: [],
      passed: 0,
      total: 0,
    };

    return result;
  }

  // Step 2: Capture observations from the frontend via WebSocket
  const captureResult = (await chatToolsService.sendToolCallRequest(
    chatId,
    toolCallId,
    toolName.captureObservations,
    {},
  )) as CaptureObservationsOutput;

  const { observations } = captureResult;

  // Step 3: Run visual tests using AnalysisService (single multi-view LLM call)
  const result = await analysisService.runVisualTests(observations, visualRequirements);

  return result;
}, testModelToolDefinition);
