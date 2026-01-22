import { describe, it, expect } from 'vitest';
import type { UIMessageChunk } from 'ai';
import { createStaticToolTransform } from '#api/chat/utils/static-tool-transform.js';

/**
 * Type for tool input chunks with dynamic flag for testing.
 */
type ToolInputChunk = {
  type: 'tool-input-start' | 'tool-input-available';
  toolCallId: string;
  toolName: string;
  input?: unknown;
  dynamic?: boolean;
};

/**
 * Helper to read all chunks from a reader.
 */
async function readAllChunks(reader: ReadableStreamDefaultReader<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const result = await reader.read();
  if (result.done) {
    return [];
  }

  const rest = await readAllChunks(reader);
  return [result.value, ...rest];
}

/**
 * Helper to process chunks through the static tool transform.
 */
async function processChunks(chunks: UIMessageChunk[]): Promise<UIMessageChunk[]> {
  const transform = createStaticToolTransform();
  const reader = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  })
    .pipeThrough(transform)
    .getReader();

  return readAllChunks(reader);
}

describe('createStaticToolTransform', () => {
  describe('static tools (read_file)', () => {
    it('should strip dynamic flag from tool-input-start for read_file', async () => {
      const toolInputStartChunk: ToolInputChunk = {
        type: 'tool-input-start',
        toolCallId: 'call_123',
        toolName: 'read_file',
        dynamic: true,
      };

      const results = await processChunks([toolInputStartChunk as unknown as UIMessageChunk]);

      expect(results).toHaveLength(1);
      const result = results[0] as unknown as ToolInputChunk;
      expect(result.type).toBe('tool-input-start');
      expect(result.toolName).toBe('read_file');
      expect(result.dynamic).toBeUndefined();
    });

    it('should strip dynamic flag from tool-input-available for read_file', async () => {
      const toolInputAvailableChunk: ToolInputChunk = {
        type: 'tool-input-available',
        toolCallId: 'call_123',
        toolName: 'read_file',
        input: { path: '/src/main.scad' },
        dynamic: true,
      };

      const results = await processChunks([toolInputAvailableChunk as unknown as UIMessageChunk]);

      expect(results).toHaveLength(1);
      const result = results[0] as unknown as ToolInputChunk;
      expect(result.type).toBe('tool-input-available');
      expect(result.toolName).toBe('read_file');
      expect(result.input).toEqual({ path: '/src/main.scad' });
      expect(result.dynamic).toBeUndefined();
    });

    it('should strip dynamic flag from other static tools (edit_file)', async () => {
      const toolInputChunk: ToolInputChunk = {
        type: 'tool-input-available',
        toolCallId: 'call_456',
        toolName: 'edit_file',
        input: { path: '/src/main.scad', content: 'cube(10);' },
        dynamic: true,
      };

      const results = await processChunks([toolInputChunk as unknown as UIMessageChunk]);

      expect(results).toHaveLength(1);
      const result = results[0] as unknown as ToolInputChunk;
      expect(result.type).toBe('tool-input-available');
      expect(result.toolName).toBe('edit_file');
      expect(result.dynamic).toBeUndefined();
    });

    it('should strip dynamic flag from list_directory tool', async () => {
      const toolInputChunk: ToolInputChunk = {
        type: 'tool-input-available',
        toolCallId: 'call_789',
        toolName: 'list_directory',
        input: { path: '/src' },
        dynamic: true,
      };

      const results = await processChunks([toolInputChunk as unknown as UIMessageChunk]);

      expect(results).toHaveLength(1);
      const result = results[0] as unknown as ToolInputChunk;
      expect(result.dynamic).toBeUndefined();
    });
  });

  describe('dynamic tools (unknown)', () => {
    it('should preserve dynamic flag for unknown tools', async () => {
      const unknownToolChunk: ToolInputChunk = {
        type: 'tool-input-available',
        toolCallId: 'call_unknown',
        toolName: 'unknown_custom_tool',
        input: { data: 'test' },
        dynamic: true,
      };

      const results = await processChunks([unknownToolChunk as unknown as UIMessageChunk]);

      expect(results).toHaveLength(1);
      const result = results[0] as unknown as ToolInputChunk;
      expect(result.type).toBe('tool-input-available');
      expect(result.toolName).toBe('unknown_custom_tool');
      expect(result.dynamic).toBe(true);
    });

    it('should preserve dynamic flag for tool-input-start of unknown tools', async () => {
      const unknownToolChunk: ToolInputChunk = {
        type: 'tool-input-start',
        toolCallId: 'call_unknown',
        toolName: 'some_dynamic_tool',
        dynamic: true,
      };

      const results = await processChunks([unknownToolChunk as unknown as UIMessageChunk]);

      expect(results).toHaveLength(1);
      const result = results[0] as unknown as ToolInputChunk;
      expect(result.dynamic).toBe(true);
    });
  });

  describe('non-tool chunks', () => {
    it('should pass through text chunks unchanged', async () => {
      const textChunk: UIMessageChunk = {
        type: 'text-delta',
        delta: 'Hello, world!',
        id: 'msg_1',
      };

      const results = await processChunks([textChunk]);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(textChunk);
    });

    it('should pass through error chunks unchanged', async () => {
      const errorChunk: UIMessageChunk = {
        type: 'error',
        errorText: 'Something went wrong',
      };

      const results = await processChunks([errorChunk]);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(errorChunk);
    });

    it('should pass through finish chunks unchanged', async () => {
      const finishChunk: UIMessageChunk = {
        type: 'finish',
        finishReason: 'stop',
      };

      const results = await processChunks([finishChunk]);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(finishChunk);
    });
  });

  describe('mixed chunks', () => {
    it('should process mixed chunk types correctly', async () => {
      const textChunk: UIMessageChunk = { type: 'text-delta', delta: 'Reading file...', id: 'msg_1' };
      const staticToolChunk: ToolInputChunk = {
        type: 'tool-input-available',
        toolCallId: 'call_1',
        toolName: 'read_file',
        input: { path: '/test.scad' },
        dynamic: true,
      };
      const dynamicToolChunk: ToolInputChunk = {
        type: 'tool-input-available',
        toolCallId: 'call_2',
        toolName: 'unknown_tool',
        input: {},
        dynamic: true,
      };
      const chunks: UIMessageChunk[] = [
        textChunk,
        staticToolChunk as unknown as UIMessageChunk,
        dynamicToolChunk as unknown as UIMessageChunk,
      ];

      const results = await processChunks(chunks);

      expect(results).toHaveLength(3);

      // Text chunk unchanged
      expect(results[0]).toEqual(textChunk);

      // Read_file should have dynamic stripped
      const readFileResult = results[1] as unknown as ToolInputChunk;
      expect(readFileResult.toolName).toBe('read_file');
      expect(readFileResult.dynamic).toBeUndefined();

      // Unknown_tool should keep dynamic
      const unknownToolResult = results[2] as unknown as ToolInputChunk;
      expect(unknownToolResult.toolName).toBe('unknown_tool');
      expect(unknownToolResult.dynamic).toBe(true);
    });

    it('should handle sequence of tool events for static tool', async () => {
      const toolInputStartChunk: ToolInputChunk = {
        type: 'tool-input-start',
        toolCallId: 'call_1',
        toolName: 'read_file',
        dynamic: true,
      };
      const toolInputAvailableChunk: ToolInputChunk = {
        type: 'tool-input-available',
        toolCallId: 'call_1',
        toolName: 'read_file',
        input: { path: '/src/main.scad' },
        dynamic: true,
      };
      const finishChunk: UIMessageChunk = {
        type: 'finish',
        finishReason: 'stop',
      };
      const chunks: UIMessageChunk[] = [
        toolInputStartChunk as unknown as UIMessageChunk,
        toolInputAvailableChunk as unknown as UIMessageChunk,
        finishChunk,
      ];

      const results = await processChunks(chunks);

      expect(results).toHaveLength(3);

      // Both tool-input events should have dynamic stripped
      expect((results[0] as unknown as ToolInputChunk).dynamic).toBeUndefined();
      expect((results[1] as unknown as ToolInputChunk).dynamic).toBeUndefined();

      // Finish chunk passes through unchanged
      expect(results[2]).toEqual(finishChunk);
    });
  });
});
