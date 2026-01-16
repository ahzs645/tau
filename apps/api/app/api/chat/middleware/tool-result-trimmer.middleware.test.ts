import { ToolMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { toolName } from '@taucad/chat/constants';
import type {
  TestModelOutput,
  TestFailure,
  CreateFileOutput,
  EditFileOutput,
  GetKernelResultOutput,
  CaptureObservationsOutput,
  ReadFileOutput,
  ListDirectoryOutput,
  GrepOutput,
  GlobSearchOutput,
} from '@taucad/chat';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toolResultTrimmerMiddleware } from '#api/chat/middleware/tool-result-trimmer.middleware.js';

/**
 * Creates a mock TestModelOutput with the given failures.
 */
function createTestModelOutput(failures: TestFailure[], passed: number): TestModelOutput {
  return {
    failures,
    passed,
    total: failures.length + passed,
  };
}

/**
 * Creates a ToolMessage with TestModelOutput content.
 * @param failures - Array of test failures
 * @param passed - Number of passed tests
 * @param options - Additional options
 */
function createTestModelToolMessage(
  failures: TestFailure[],
  passed: number,
  options: { includeName?: boolean; toolCallId?: string } = {},
): ToolMessage {
  const { includeName = true, toolCallId = 'call_123' } = options;
  const output = createTestModelOutput(failures, passed);

  return new ToolMessage({
    content: JSON.stringify(output),
    // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
    tool_call_id: toolCallId,
    ...(includeName ? { name: toolName.testModel } : {}),
  });
}

/**
 * Creates a plain object that looks like a deserialized ToolMessage.
 * This simulates what happens when messages are loaded from PostgresSaver checkpoint.
 */
function createDeserializedToolMessage(
  failures: TestFailure[],
  passed: number,
  options: { includeName?: boolean; toolCallId?: string } = {},
): unknown {
  const { includeName = true, toolCallId = 'call_123' } = options;
  const output = createTestModelOutput(failures, passed);

  return {
    type: 'tool',
    content: JSON.stringify(output),
    // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
    tool_call_id: toolCallId,
    ...(includeName ? { name: toolName.testModel } : {}),
    id: ['tool', toolCallId],
    lc: 1,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
    lc_serializable: true,
  };
}

/**
 * Helper to parse the content of a ToolMessage.
 */
function parseTestModelOutput(message: ToolMessage): TestModelOutput {
  const content = message.content as string;

  return JSON.parse(content) as TestModelOutput;
}

// Helper type for the request shape we're testing
type TestRequest = { messages: BaseMessage[] };

// Helper to call wrapModelCall with proper typing
async function callWrapModelCall(request: TestRequest, handler: ReturnType<typeof vi.fn>): Promise<void> {
  const { wrapModelCall } = toolResultTrimmerMiddleware;
  if (!wrapModelCall) {
    throw new Error('wrapModelCall is not defined on middleware');
  }

  // Cast to the expected types - in tests we only care about messages
  await wrapModelCall(request as Parameters<typeof wrapModelCall>[0], handler);
}

describe('toolResultTrimmerMiddleware', () => {
  let handler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handler = vi.fn().mockResolvedValue({ content: 'response' });
  });

  describe('single message - with tool name', () => {
    it('should trim passed count from TestModelOutput when message has tool name', async () => {
      const failures: TestFailure[] = [
        {
          id: 'req_1',
          requirement: 'Model should be a sphere',
          reason: 'Model is a cube',
          suggestion: 'Use sphere() primitive',
        },
      ];
      const toolMessage = createTestModelToolMessage(failures, 3);

      await callWrapModelCall({ messages: [toolMessage] }, handler);

      expect(handler).toHaveBeenCalledTimes(1);
      const [request] = handler.mock.calls[0] as [TestRequest];
      const trimmedMessage = request.messages[0] as ToolMessage;

      expect(ToolMessage.isInstance(trimmedMessage)).toBe(true);
      const parsed = parseTestModelOutput(trimmedMessage);
      // Passed should be removed
      expect(parsed.passed).toBeUndefined();
      // Failures and total should be preserved
      expect(parsed.failures).toHaveLength(1);
      expect(parsed.total).toBe(4);
    });
  });

  describe('single message - without tool name (content-based detection)', () => {
    it('should trim passed count from TestModelOutput using content shape detection', async () => {
      const failures: TestFailure[] = [];
      // Simulate @ai-sdk/langchain behavior: no name property set
      const toolMessage = createTestModelToolMessage(failures, 5, { includeName: false });

      await callWrapModelCall({ messages: [toolMessage] }, handler);

      expect(handler).toHaveBeenCalledTimes(1);
      const [request] = handler.mock.calls[0] as [TestRequest];
      const trimmedMessage = request.messages[0] as ToolMessage;

      expect(ToolMessage.isInstance(trimmedMessage)).toBe(true);
      const parsed = parseTestModelOutput(trimmedMessage);
      expect(parsed.passed).toBeUndefined();
      expect(parsed.failures).toHaveLength(0);
      expect(parsed.total).toBe(5);
    });
  });

  describe('multi-message chat - multiple tool messages', () => {
    it('should trim passed count from all TestModelOutput messages in conversation', async () => {
      const failures1: TestFailure[] = [{ id: 'req_1', requirement: 'Test 1', reason: 'Failed', suggestion: 'Fix it' }];
      const failures2: TestFailure[] = [];

      const messages: BaseMessage[] = [
        new HumanMessage('Build a sphere'),
        new AIMessage({
          content: '',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_calls: [{ id: 'call_1', name: toolName.testModel, args: {} }],
        }),
        createTestModelToolMessage(failures1, 2, { toolCallId: 'call_1' }),
        new AIMessage('Fixed the issue, testing again'),
        new AIMessage({
          content: '',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_calls: [{ id: 'call_2', name: toolName.testModel, args: {} }],
        }),
        createTestModelToolMessage(failures2, 3, { toolCallId: 'call_2' }),
        new HumanMessage('Great!'),
      ];

      await callWrapModelCall({ messages }, handler);

      expect(handler).toHaveBeenCalledTimes(1);
      const [request] = handler.mock.calls[0] as [TestRequest];

      // Find the tool messages and verify they were trimmed
      const toolMessages = request.messages.filter((message) => ToolMessage.isInstance(message)) as ToolMessage[];
      expect(toolMessages).toHaveLength(2);

      for (const toolMessage of toolMessages) {
        const parsed = parseTestModelOutput(toolMessage);
        expect(parsed.passed).toBeUndefined();
      }
    });

    it('should trim passed count from tool messages without name in multi-message chat', async () => {
      const failures1: TestFailure[] = [{ id: 'req_1', requirement: 'Test 1', reason: 'Failed', suggestion: 'Fix it' }];
      const failures2: TestFailure[] = [];

      const messages: BaseMessage[] = [
        new HumanMessage('Check the model'),
        // Simulating messages from @ai-sdk/langchain adapter (no name)
        createTestModelToolMessage(failures1, 2, { includeName: false, toolCallId: 'call_1' }),
        new AIMessage('Fixing...'),
        createTestModelToolMessage(failures2, 3, { includeName: false, toolCallId: 'call_2' }),
      ];

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      const toolMessages = request.messages.filter((message) => ToolMessage.isInstance(message)) as ToolMessage[];

      expect(toolMessages).toHaveLength(2);
      for (const toolMessage of toolMessages) {
        const parsed = parseTestModelOutput(toolMessage);
        expect(parsed.passed).toBeUndefined();
      }
    });
  });

  describe('deserialized messages from checkpoint', () => {
    it('should trim passed count from deserialized ToolMessage objects', async () => {
      const failures: TestFailure[] = [{ id: 'req_1', requirement: 'Test 1', reason: 'Failed', suggestion: 'Fix it' }];
      // This simulates a message loaded from PostgresSaver that lost its prototype
      const deserializedMessage = createDeserializedToolMessage(failures, 2);

      await callWrapModelCall({ messages: [deserializedMessage as BaseMessage] }, handler);

      expect(handler).toHaveBeenCalledTimes(1);
      const [request] = handler.mock.calls[0] as [TestRequest];
      const trimmedMessage = request.messages[0];

      // The message should be detected as a ToolMessage and trimmed
      const { content } = trimmedMessage as { content: string };
      const parsed = JSON.parse(content) as TestModelOutput;
      expect(parsed.passed).toBeUndefined();
      expect(parsed.failures).toHaveLength(1);
      expect(parsed.total).toBe(3);
    });

    it('should trim deserialized messages without name property', async () => {
      const failures: TestFailure[] = [];
      const deserializedMessage = createDeserializedToolMessage(failures, 5, { includeName: false });

      await callWrapModelCall({ messages: [deserializedMessage as BaseMessage] }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      const message = request.messages[0] as { content: string };
      const parsed = JSON.parse(message.content) as TestModelOutput;

      expect(parsed.passed).toBeUndefined();
      expect(parsed.total).toBe(5);
    });
  });

  describe('non-matching messages', () => {
    it('should not modify non-ToolMessage messages', async () => {
      const humanMessage = new HumanMessage('Hello');
      const aiMessage = new AIMessage('Hi there');

      await callWrapModelCall({ messages: [humanMessage, aiMessage] }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      expect(request.messages[0]).toBe(humanMessage);
      expect(request.messages[1]).toBe(aiMessage);
    });

    it('should not modify ToolMessage with non-matching content shape', async () => {
      const otherToolOutput = { result: 'some data', value: 42 };
      const toolMessage = new ToolMessage({
        content: JSON.stringify(otherToolOutput),
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        tool_call_id: 'call_other',
        name: 'other_tool',
      });

      await callWrapModelCall({ messages: [toolMessage] }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      const resultMessage = request.messages[0] as ToolMessage;
      const parsed = JSON.parse(resultMessage.content as string) as typeof otherToolOutput;

      expect(parsed).toEqual(otherToolOutput);
    });

    it('should not modify ToolMessage with invalid JSON content', async () => {
      const toolMessage = new ToolMessage({
        content: 'not valid json',
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        tool_call_id: 'call_invalid',
        name: toolName.testModel,
      });

      await callWrapModelCall({ messages: [toolMessage] }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      const resultMessage = request.messages[0] as ToolMessage;
      expect(resultMessage.content).toBe('not valid json');
    });
  });

  describe('preserves other message properties', () => {
    it('should preserve tool_call_id and other properties after trimming', async () => {
      const failures: TestFailure[] = [{ id: 'req_1', requirement: 'Test', reason: 'Failed', suggestion: 'Fix' }];
      const toolMessage = createTestModelToolMessage(failures, 2, {
        toolCallId: 'call_preserve_test',
      });

      await callWrapModelCall({ messages: [toolMessage] }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      const trimmedMessage = request.messages[0] as ToolMessage;

      expect(trimmedMessage.tool_call_id).toBe('call_preserve_test');
      expect(trimmedMessage.name).toBe(toolName.testModel);
    });

    it('should preserve failures array content after trimming', async () => {
      const failures: TestFailure[] = [
        {
          id: 'req_sphere',
          requirement: 'Model should be a sphere',
          reason: 'Top view shows toroidal structure',
          suggestion: 'Use sphere() primitive instead of torus',
        },
        {
          id: 'req_hole',
          requirement: 'Hole should be centered',
          reason: 'Hole is offset by 5mm',
          suggestion: 'Translate hole to origin',
        },
      ];

      const toolMessage = createTestModelToolMessage(failures, 2);

      await callWrapModelCall({ messages: [toolMessage] }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      const trimmedMessage = request.messages[0] as ToolMessage;
      const parsed = parseTestModelOutput(trimmedMessage);

      // Passed should be removed
      expect(parsed.passed).toBeUndefined();

      // Failures and total should be preserved exactly
      expect(parsed.failures).toEqual(failures);
      expect(parsed.total).toBe(4);
    });
  });

  // ==========================================================================
  // Immediate Trimmers for File Operations
  // ==========================================================================

  describe('create_file trimmer', () => {
    function createCreateFileOutput(): CreateFileOutput {
      return {
        success: true,
        message: 'File created successfully',
        diffStats: {
          linesAdded: 25,
          linesRemoved: 0,
          originalContent: '',
          modifiedContent: 'const x = 1;\nconst y = 2;\n// ... many more lines',
        },
      };
    }

    it('should remove originalContent and modifiedContent from diffStats', async () => {
      const output = createCreateFileOutput();
      const toolMessage = new ToolMessage({
        content: JSON.stringify(output),
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        tool_call_id: 'call_create_1',
        name: toolName.createFile,
      });

      await callWrapModelCall({ messages: [toolMessage] }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      const trimmedMessage = request.messages[0] as ToolMessage;
      const parsed = JSON.parse(trimmedMessage.content as string) as unknown;

      expect(parsed).toEqual({
        success: true,
        message: 'File created successfully',
        diffStats: {
          linesAdded: 25,
          linesRemoved: 0,
        },
      });
    });

    it('should detect create_file by content shape when name is missing', async () => {
      const output = createCreateFileOutput();
      const toolMessage = new ToolMessage({
        content: JSON.stringify(output),
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        tool_call_id: 'call_create_2',
        // No name set
      });

      await callWrapModelCall({ messages: [toolMessage] }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      const trimmedMessage = request.messages[0] as ToolMessage;
      const parsed = JSON.parse(trimmedMessage.content as string) as unknown;

      expect(parsed).toEqual({
        success: true,
        message: 'File created successfully',
        diffStats: {
          linesAdded: 25,
          linesRemoved: 0,
        },
      });
    });
  });

  describe('edit_file trimmer', () => {
    function createEditFileOutput(): EditFileOutput {
      return {
        success: true,
        diffStats: {
          linesAdded: 10,
          linesRemoved: 5,
          originalContent: 'const old = true;',
          modifiedContent: 'const new_ = false;',
        },
      };
    }

    it('should remove originalContent and modifiedContent from diffStats', async () => {
      const output = createEditFileOutput();
      const toolMessage = new ToolMessage({
        content: JSON.stringify(output),
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        tool_call_id: 'call_edit_1',
        name: toolName.editFile,
      });

      await callWrapModelCall({ messages: [toolMessage] }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      const trimmedMessage = request.messages[0] as ToolMessage;
      const parsed = JSON.parse(trimmedMessage.content as string) as unknown;

      expect(parsed).toEqual({
        success: true,
        diffStats: {
          linesAdded: 10,
          linesRemoved: 5,
        },
      });
    });
  });

  describe('get_kernel_result trimmer', () => {
    function createGetKernelResultOutput(): GetKernelResultOutput {
      return {
        status: 'error',
        kernelIssues: [
          {
            message: 'Syntax error on line 5',
            location: {
              fileName: 'main.scad',
              startLineNumber: 5,
              startColumn: 10,
            },
            severity: 'error',
            type: 'compilation',
            stack: 'Error: Syntax error\n  at line 5\n  at compile()',
            stackFrames: [
              { fileName: 'main.scad', lineNumber: 5, functionName: 'compile' },
              { fileName: 'kernel.js', lineNumber: 100, functionName: 'execute' },
            ],
          },
        ],
      };
    }

    it('should preserve stack and stackFrames in kernel issues for debugging', async () => {
      const output = createGetKernelResultOutput();
      const toolMessage = new ToolMessage({
        content: JSON.stringify(output),
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        tool_call_id: 'call_kernel_1',
        name: toolName.getKernelResult,
      });

      await callWrapModelCall({ messages: [toolMessage] }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      const trimmedMessage = request.messages[0] as ToolMessage;
      const parsed = JSON.parse(trimmedMessage.content as string) as unknown;

      expect(parsed).toEqual({
        status: 'error',
        kernelIssues: [
          {
            message: 'Syntax error on line 5',
            location: {
              fileName: 'main.scad',
              startLineNumber: 5,
              startColumn: 10,
            },
            severity: 'error',
            type: 'compilation',
            stack: 'Error: Syntax error\n  at line 5\n  at compile()',
            stackFrames: [
              { fileName: 'main.scad', lineNumber: 5, functionName: 'compile' },
              { fileName: 'kernel.js', lineNumber: 100, functionName: 'execute' },
            ],
          },
        ],
      });
    });

    it('should handle kernel result with ready status and no issues', async () => {
      const output: GetKernelResultOutput = { status: 'ready' };
      const toolMessage = new ToolMessage({
        content: JSON.stringify(output),
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        tool_call_id: 'call_kernel_2',
        name: toolName.getKernelResult,
      });

      await callWrapModelCall({ messages: [toolMessage] }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      const trimmedMessage = request.messages[0] as ToolMessage;
      const parsed = JSON.parse(trimmedMessage.content as string) as unknown;

      expect(parsed).toEqual({ status: 'ready' });
    });
  });

  describe('capture_observations trimmer', () => {
    function createCaptureObservationsOutput(): CaptureObservationsOutput {
      return {
        observations: [
          { id: 'obs_1', side: 'front', src: 'data:image/png;base64,iVBORw0KGgo...very_long_base64_string' },
          { id: 'obs_2', side: 'top', src: 'data:image/png;base64,another_very_long_base64_string' },
        ],
      };
    }

    it('should remove base64 src from observations', async () => {
      const output = createCaptureObservationsOutput();
      const toolMessage = new ToolMessage({
        content: JSON.stringify(output),
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        tool_call_id: 'call_obs_1',
        name: toolName.captureObservations,
      });

      await callWrapModelCall({ messages: [toolMessage] }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      const trimmedMessage = request.messages[0] as ToolMessage;
      const parsed = JSON.parse(trimmedMessage.content as string) as unknown;

      expect(parsed).toEqual({
        observations: [
          { id: 'obs_1', side: 'front' },
          { id: 'obs_2', side: 'top' },
        ],
      });
    });
  });

  // ==========================================================================
  // Progressive Trimmers (for older messages)
  // ==========================================================================

  describe('progressive trimming', () => {
    // The recency window is 5, so we need more than 5 tool messages
    // to trigger progressive trimming on older ones

    function createReadFileOutput(): ReadFileOutput {
      return {
        content: 'const x = 1;\nconst y = 2;\nconst z = 3;',
        totalLines: 150,
        startLine: 1,
      };
    }

    function createListDirectoryOutput(): ListDirectoryOutput {
      return {
        entries: [
          { name: 'file1.ts', type: 'file', size: 100 },
          { name: 'file2.ts', type: 'file', size: 200 },
          { name: 'subdir', type: 'dir', size: 3 },
        ],
        path: '/project/src',
      };
    }

    function createGrepOutput(): GrepOutput {
      return {
        matches: [
          { file: 'src/a.ts', line: 10, content: 'const foo = bar;' },
          { file: 'src/b.ts', line: 20, content: 'const baz = qux;' },
        ],
        totalMatches: 2,
      };
    }

    function createGlobSearchOutput(): GlobSearchOutput {
      return {
        files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        totalFiles: 3,
      };
    }

    it('should apply progressive trimming to read_file beyond recency window', async () => {
      // Create 6 tool messages (more than recency window of 5)
      // The first one should get progressive trimming
      const messages: BaseMessage[] = [];

      // Old read_file (will be progressively trimmed)
      messages.push(
        new ToolMessage({
          content: JSON.stringify(createReadFileOutput()),
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_call_id: 'call_old_1',
          name: toolName.readFile,
        }),
      );

      // Add 5 more recent tool messages (within recency window)
      for (let i = 0; i < 5; i++) {
        messages.push(
          new ToolMessage({
            content: JSON.stringify(createReadFileOutput()),
            // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
            tool_call_id: `call_recent_${i}`,
            name: toolName.readFile,
          }),
        );
      }

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];

      // First message (old) should be progressively trimmed
      const oldMessage = request.messages[0] as ToolMessage;
      const oldParsed = JSON.parse(oldMessage.content as string) as unknown;
      expect(oldParsed).toEqual({
        content: '[File content trimmed: 150 lines]',
        totalLines: 150,
        startLine: 1,
      });

      // Recent messages should keep full content
      const recentMessage = request.messages[5] as ToolMessage;
      const recentParsed = JSON.parse(recentMessage.content as string) as unknown;
      expect(recentParsed).toEqual({
        content: 'const x = 1;\nconst y = 2;\nconst z = 3;',
        totalLines: 150,
        startLine: 1,
      });
    });

    it('should apply progressive trimming to list_directory beyond recency window', async () => {
      const messages: BaseMessage[] = [];

      // Old list_directory
      messages.push(
        new ToolMessage({
          content: JSON.stringify(createListDirectoryOutput()),
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_call_id: 'call_old_list',
          name: toolName.listDirectory,
        }),
      );

      // Add 5 more recent tool messages
      for (let i = 0; i < 5; i++) {
        messages.push(
          new ToolMessage({
            content: JSON.stringify(createReadFileOutput()),
            // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
            tool_call_id: `call_recent_${i}`,
            name: toolName.readFile,
          }),
        );
      }

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];

      const oldMessage = request.messages[0] as ToolMessage;
      const oldParsed = JSON.parse(oldMessage.content as string) as unknown;
      expect(oldParsed).toEqual({
        entries: '[Directory listing trimmed: 2 files, 1 directories]',
        path: '/project/src',
      });
    });

    it('should apply progressive trimming to grep beyond recency window', async () => {
      const messages: BaseMessage[] = [];

      // Old grep
      messages.push(
        new ToolMessage({
          content: JSON.stringify(createGrepOutput()),
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_call_id: 'call_old_grep',
          name: toolName.grep,
        }),
      );

      // Add 5 more recent tool messages
      for (let i = 0; i < 5; i++) {
        messages.push(
          new ToolMessage({
            content: JSON.stringify(createReadFileOutput()),
            // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
            tool_call_id: `call_recent_${i}`,
            name: toolName.readFile,
          }),
        );
      }

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];

      const oldMessage = request.messages[0] as ToolMessage;
      const oldParsed = JSON.parse(oldMessage.content as string) as unknown;
      expect(oldParsed).toEqual({
        matches: '[Grep results trimmed: 2 matches in 2 files]',
        totalMatches: 2,
      });
    });

    it('should apply progressive trimming to glob_search beyond recency window', async () => {
      const messages: BaseMessage[] = [];

      // Old glob_search
      messages.push(
        new ToolMessage({
          content: JSON.stringify(createGlobSearchOutput()),
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_call_id: 'call_old_glob',
          name: toolName.globSearch,
        }),
      );

      // Add 5 more recent tool messages
      for (let i = 0; i < 5; i++) {
        messages.push(
          new ToolMessage({
            content: JSON.stringify(createReadFileOutput()),
            // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
            tool_call_id: `call_recent_${i}`,
            name: toolName.readFile,
          }),
        );
      }

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];

      const oldMessage = request.messages[0] as ToolMessage;
      const oldParsed = JSON.parse(oldMessage.content as string) as unknown;
      expect(oldParsed).toEqual({
        files: '[File list trimmed: 3 files matched]',
        totalFiles: 3,
      });
    });

    it('should not apply progressive trimming within recency window', async () => {
      // Only 3 tool messages - all within recency window
      const messages: BaseMessage[] = [
        new ToolMessage({
          content: JSON.stringify(createReadFileOutput()),
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_call_id: 'call_1',
          name: toolName.readFile,
        }),
        new ToolMessage({
          content: JSON.stringify(createReadFileOutput()),
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_call_id: 'call_2',
          name: toolName.readFile,
        }),
        new ToolMessage({
          content: JSON.stringify(createReadFileOutput()),
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_call_id: 'call_3',
          name: toolName.readFile,
        }),
      ];

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];

      // All messages should keep full content (no trimmer for read_file in immediate trimmers)
      for (const message of request.messages) {
        const parsed = JSON.parse((message as ToolMessage).content as string) as unknown;
        expect(parsed).toEqual({
          content: 'const x = 1;\nconst y = 2;\nconst z = 3;',
          totalLines: 150,
          startLine: 1,
        });
      }
    });
  });

  // ==========================================================================
  // Stale File Detection
  // ==========================================================================

  describe('stale file detection', () => {
    function createReadFileOutput(content: string): ReadFileOutput {
      return {
        content,
        totalLines: 10,
        startLine: 1,
      };
    }

    it('should mark read_file as stale when file was modified after the read', async () => {
      const messages: BaseMessage[] = [
        // First: AI calls read_file
        new AIMessage({
          content: '',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_calls: [{ id: 'call_read_1', name: toolName.readFile, args: { targetFile: 'main.scad' } }],
        }),
        // Second: read_file result
        new ToolMessage({
          content: JSON.stringify(createReadFileOutput('original content')),
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_call_id: 'call_read_1',
          name: toolName.readFile,
        }),
        // Third: AI calls edit_file on the same file
        new AIMessage({
          content: '',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_calls: [
            {
              id: 'call_edit_1',
              name: toolName.editFile,
              args: { targetFile: 'main.scad', codeEdit: 'new content' },
            },
          ],
        }),
        // Fourth: edit_file result
        new ToolMessage({
          content: JSON.stringify({
            success: true,
            diffStats: { linesAdded: 5, linesRemoved: 2, originalContent: '', modifiedContent: '' },
          }),
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_call_id: 'call_edit_1',
          name: toolName.editFile,
        }),
      ];

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];

      // The read_file result should be marked as stale
      const readMessage = request.messages[1] as ToolMessage;
      const readParsed = JSON.parse(readMessage.content as string) as unknown;
      expect(readParsed).toEqual({
        content: '[File was modified after this read - content is stale]',
        totalLines: 10,
        startLine: 1,
      });
    });

    it('should not mark read_file as stale when file was not modified', async () => {
      const messages: BaseMessage[] = [
        // AI calls read_file
        new AIMessage({
          content: '',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_calls: [{ id: 'call_read_1', name: toolName.readFile, args: { targetFile: 'main.scad' } }],
        }),
        // Read_file result
        new ToolMessage({
          content: JSON.stringify(createReadFileOutput('file content')),
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_call_id: 'call_read_1',
          name: toolName.readFile,
        }),
        // AI calls edit_file on a DIFFERENT file
        new AIMessage({
          content: '',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_calls: [
            {
              id: 'call_edit_1',
              name: toolName.editFile,
              args: { targetFile: 'other.scad', codeEdit: 'new content' },
            },
          ],
        }),
      ];

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];

      // The read_file result should NOT be marked as stale
      const readMessage = request.messages[1] as ToolMessage;
      const readParsed = JSON.parse(readMessage.content as string) as unknown;
      expect(readParsed).toEqual({
        content: 'file content',
        totalLines: 10,
        startLine: 1,
      });
    });

    it('should handle stale detection with create_file', async () => {
      const messages: BaseMessage[] = [
        // AI calls read_file
        new AIMessage({
          content: '',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_calls: [{ id: 'call_read_1', name: toolName.readFile, args: { targetFile: 'new-file.scad' } }],
        }),
        // Read_file result (maybe file didn't exist or was empty)
        new ToolMessage({
          content: JSON.stringify(createReadFileOutput('')),
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_call_id: 'call_read_1',
          name: toolName.readFile,
        }),
        // AI calls create_file on the same file
        new AIMessage({
          content: '',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_calls: [
            {
              id: 'call_create_1',
              name: toolName.createFile,
              args: { targetFile: 'new-file.scad', content: 'new content' },
            },
          ],
        }),
      ];

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];

      // The read_file result should be marked as stale
      const readMessage = request.messages[1] as ToolMessage;
      const readParsed = JSON.parse(readMessage.content as string) as unknown;
      expect(readParsed).toEqual({
        content: '[File was modified after this read - content is stale]',
        totalLines: 10,
        startLine: 1,
      });
    });

    it('should not mark read_file as stale if edit happened before the read', async () => {
      const messages: BaseMessage[] = [
        // First: AI calls edit_file
        new AIMessage({
          content: '',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_calls: [
            {
              id: 'call_edit_1',
              name: toolName.editFile,
              args: { targetFile: 'main.scad', codeEdit: 'old edit' },
            },
          ],
        }),
        // Second: edit_file result
        new ToolMessage({
          content: JSON.stringify({
            success: true,
            diffStats: { linesAdded: 1, linesRemoved: 0, originalContent: '', modifiedContent: '' },
          }),
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_call_id: 'call_edit_1',
          name: toolName.editFile,
        }),
        // Third: AI calls read_file AFTER the edit
        new AIMessage({
          content: '',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_calls: [{ id: 'call_read_1', name: toolName.readFile, args: { targetFile: 'main.scad' } }],
        }),
        // Fourth: read_file result (after edit, so it's current)
        new ToolMessage({
          content: JSON.stringify(createReadFileOutput('current content after edit')),
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_call_id: 'call_read_1',
          name: toolName.readFile,
        }),
      ];

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];

      // The read_file result should NOT be marked as stale (edit happened before)
      const readMessage = request.messages[3] as ToolMessage;
      const readParsed = JSON.parse(readMessage.content as string) as unknown;
      expect(readParsed).toEqual({
        content: 'current content after edit',
        totalLines: 10,
        startLine: 1,
      });
    });
  });
});
