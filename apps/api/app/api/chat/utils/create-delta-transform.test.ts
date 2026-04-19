import type { UIMessageChunk } from 'ai';
import { describe, it, expect } from 'vitest';
import { createDeltaTransform } from '#api/chat/utils/create-delta-transform.js';

const toUpperCase = (text: string): string => text.toUpperCase();
const identity = (text: string): string => text;

async function readAllChunks(reader: ReadableStreamDefaultReader<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const result = await reader.read();
  if (result.done) {
    return [];
  }

  const rest = await readAllChunks(reader);
  return [result.value, ...rest];
}

async function processChunks(
  chunks: UIMessageChunk[],
  transformDelta: (delta: string) => string,
): Promise<UIMessageChunk[]> {
  const transform = createDeltaTransform(transformDelta);
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

function extractDeltas(chunks: UIMessageChunk[]): string[] {
  return chunks
    .filter((c): c is UIMessageChunk & { delta: string } => 'delta' in c && typeof c.delta === 'string')
    .map((c) => c.delta);
}

describe('createDeltaTransform', () => {
  describe('text-delta chunks', () => {
    it('should apply fn to text-delta chunks', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'hello world' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks, toUpperCase);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['HELLO WORLD']);
    });

    it('should pass through text-delta unchanged when fn returns same value', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'unchanged' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks, identity);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['unchanged']);
    });
  });

  describe('reasoning-delta chunks', () => {
    it('should apply fn to reasoning-delta chunks', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'thinking' },
        { type: 'reasoning-end', id: 'r1' },
      ];

      const results = await processChunks(chunks, toUpperCase);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['THINKING']);
    });
  });

  describe('passthrough', () => {
    it('should pass through tool chunks unchanged', async () => {
      const toolStart: UIMessageChunk = { type: 'tool-input-start', toolCallId: 'c1', toolName: 'read_file' };
      const toolAvailable: UIMessageChunk = {
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'read_file',
        input: {},
      };
      const chunks = [toolStart, toolAvailable];

      const results = await processChunks(chunks, toUpperCase);

      expect(results).toEqual(chunks);
    });

    it('should pass through error chunks unchanged', async () => {
      const errorChunk: UIMessageChunk = { type: 'error', errorText: 'fail' };

      const results = await processChunks([errorChunk], toUpperCase);

      expect(results).toEqual([errorChunk]);
    });

    it('should pass through lifecycle chunks unchanged', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'start' },
        { type: 'start-step' },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ];

      const results = await processChunks(chunks, toUpperCase);

      expect(results).toEqual(chunks);
    });

    it('should pass through text-start and text-end unchanged', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks, toUpperCase);

      expect(results).toEqual(chunks);
    });
  });

  describe('mixed blocks', () => {
    it('should apply fn to both text-delta and reasoning-delta independently', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'thinking' },
        { type: 'reasoning-end', id: 'r1' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'response' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks, toUpperCase);
      const reasoningDeltas = results
        .filter((c): c is UIMessageChunk & { delta: string } => c.type === 'reasoning-delta' && 'delta' in c)
        .map((c) => c.delta);
      const textDeltas = results
        .filter((c): c is UIMessageChunk & { delta: string } => c.type === 'text-delta' && 'delta' in c)
        .map((c) => c.delta);

      expect(reasoningDeltas).toEqual(['THINKING']);
      expect(textDeltas).toEqual(['RESPONSE']);
    });
  });

  describe('empty deltas', () => {
    it('should handle empty delta strings', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: '' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks, toUpperCase);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['']);
    });
  });
});
