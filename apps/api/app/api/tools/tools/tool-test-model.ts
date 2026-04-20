import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { testModelInputSchema, isRpcClientError } from '@taucad/chat';
import { assertRpcExecution, assertRpcSuccess } from '@taucad/chat/utils';
import type { ChatTool, TestModelInput } from '@taucad/chat';
import { testFileSchema } from '@taucad/testing';
import type { TestFailure, TestModelOutput, TestPass } from '@taucad/testing';
import { rpcName, toolName } from '@taucad/chat/constants';
import type { ChatRpcConfigurable } from '#api/tools/tool.types.js';

export const testModelToolDefinition = {
  name: toolName.testModel,
  description: `Run all tests from test.json against the current 3D model(s).

test.json is a per-file map keyed by source file path. Each entry holds the
requirements that will be evaluated against THAT file's geometry only. This
tool fans out one geometry fetch per file in parallel, runs that file's
requirements, and aggregates the tagged results.

Returns:
- failures: Array of failed tests, each tagged with its originating targetFile
- passes: Array of passed tests, each tagged with its originating targetFile
- passed: Total number of tests that passed across all files
- total: Total number of tests run across all files
- geometryArtifactPaths: Map of source file path → captured GLB artifact path

If failures is empty, all tests passed.

Note: Reads the per-file requirements map from test.json. Use edit_tests to
add or modify per-file requirements before running tests.`,
  schema: testModelInputSchema,
} as const;

type ReadFailureOptions = {
  readonly id: string;
  readonly requirement: string;
  readonly reason: string;
  readonly suggestion: string;
};

const buildReadFailure = (options: ReadFailureOptions): TestModelOutput => ({
  failures: [{ ...options, targetFile: 'test.json' }],
  passes: [],
  passed: 0,
  total: 0,
});

export const testModelTool: ChatTool<
  typeof testModelInputSchema,
  TestModelInput,
  TestModelOutput,
  typeof toolName.testModel
> = tool(async (_input, runtime: ToolRuntime) => {
  const { chatRpcService, geometryAnalysisService, thread_id: chatId } = runtime.configurable as ChatRpcConfigurable;
  const { toolCallId } = runtime;

  const testFileContent = await chatRpcService.sendRpcRequest({
    chatId,
    toolCallId,
    rpcName: rpcName.readFile,
    args: { targetFile: 'test.json' },
  });

  assertRpcExecution(testFileContent, toolName.testModel, toolCallId);

  if (isRpcClientError(testFileContent)) {
    return buildReadFailure({
      id: 'missing_test_file',
      requirement: 'test.json file must exist',
      reason: 'No test.json file found in project root',
      suggestion:
        'Use edit_tests to create test.json with a per-file requirements map (e.g. { "main.ts": { "requirements": [...] } }) before running tests',
    });
  }

  if (testFileContent.content === '') {
    return buildReadFailure({
      id: 'empty_test_file',
      requirement: 'test.json file must have content',
      reason: 'test.json file is empty',
      suggestion:
        'Use edit_tests to add a per-file requirements map to test.json (e.g. { "main.ts": { "requirements": [...] } })',
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(testFileContent.content);
  } catch {
    return buildReadFailure({
      id: 'invalid_test_file',
      requirement: 'test.json must be valid JSON with a per-file requirements map',
      reason: 'Failed to parse test.json - invalid JSON',
      suggestion:
        'Ensure test.json is valid JSON shaped as a per-file map: keys are source file paths (e.g. "main.ts"), values are { "requirements": [...] }',
    });
  }

  const parseResult = testFileSchema.safeParse(parsed);
  if (!parseResult.success) {
    return buildReadFailure({
      id: 'invalid_test_file',
      requirement: 'test.json must be a per-file requirements map',
      reason: `test.json does not match the expected per-file shape: ${parseResult.error.issues.map((i) => i.message).join('; ')}`,
      suggestion:
        'Use edit_tests to write test.json as a per-file map. Each top-level key must be a source file path (e.g. "main.ts"); each value must be { "requirements": [...] } scoped to that file.',
    });
  }

  const testFile = parseResult.data;
  const entries = Object.entries(testFile);

  const totalRequirements = entries.reduce((sum, [, entry]) => sum + entry.requirements.length, 0);
  if (totalRequirements === 0) {
    return buildReadFailure({
      id: 'no_requirements',
      requirement: 'test.json must contain at least one requirement',
      reason: 'No requirements found in any file entry of test.json',
      suggestion: 'Use edit_tests to add measurement requirements to at least one file entry in test.json',
    });
  }

  const perFileResults = await Promise.all(
    entries
      .filter(([, entry]) => entry.requirements.length > 0)
      .map(async ([targetFile, { requirements }]) => {
        const geometryResult = await chatRpcService.sendRpcRequest({
          chatId,
          toolCallId,
          rpcName: rpcName.fetchGeometry,
          args: { artifactId: toolCallId, targetFile },
        });

        assertRpcSuccess(geometryResult, {
          toolName: toolName.testModel,
          toolCallId,
          clientErrorMessage(error) {
            switch (error.errorCode) {
              case 'UNKNOWN_COMPILATION_UNIT': {
                return `No compilation unit exists for ${targetFile}. Open the file in the editor or call get_kernel_result against ${targetFile} first to bootstrap it.`;
              }
              case 'UNKNOWN': {
                if (error.message.includes('No GLTF geometry available for')) {
                  return `${targetFile} compiled successfully but produced no top-level geometry. This is typical of OpenSCAD library files (only module declarations, no top-level call). Either remove the entry for ${targetFile} from test.json with edit_tests, or add a top-level invocation to ${targetFile} so it renders standalone geometry.`;
                }
                return `Failed to fetch geometry for ${targetFile}: ${error.message}`;
              }
              default: {
                return `Failed to fetch geometry for ${targetFile} [${error.errorCode}]: ${error.message}`;
              }
            }
          },
        });

        const result = await geometryAnalysisService.runMeasurementTests(geometryResult.glb, requirements, targetFile);

        return { targetFile, result, artifactPath: geometryResult.artifactPath };
      }),
  );

  const failures: TestFailure[] = perFileResults.flatMap((r) => r.result.failures);
  const passes: TestPass[] = perFileResults.flatMap((r) => r.result.passes);

  const geometryArtifactPaths = Object.fromEntries(
    perFileResults
      .filter((r): r is typeof r & { artifactPath: string } => r.artifactPath !== undefined)
      .map((r) => [r.targetFile, r.artifactPath]),
  );

  return {
    failures,
    passes,
    passed: passes.length,
    total: failures.length + passes.length,
    geometryArtifactPaths: Object.keys(geometryArtifactPaths).length > 0 ? geometryArtifactPaths : undefined,
  };
}, testModelToolDefinition);
