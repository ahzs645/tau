import type { UIMessageChunk } from 'ai';
import { describe, it, expect } from 'vitest';
import { createLatexDelimiterTransform } from '#api/chat/utils/latex-delimiter-transform.js';

async function readAllChunks(reader: ReadableStreamDefaultReader<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const result = await reader.read();
  if (result.done) {
    return [];
  }

  const rest = await readAllChunks(reader);
  return [result.value, ...rest];
}

async function processChunks(chunks: UIMessageChunk[]): Promise<UIMessageChunk[]> {
  const transform = createLatexDelimiterTransform();
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

describe('createLatexDelimiterTransform', () => {
  describe('reasoning-delta chunks', () => {
    it('should normalize inline math delimiters in reasoning-delta', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: String.raw`The formula \(x^2 + y^2 = r^2\) describes a circle` },
        { type: 'reasoning-end', id: 'r1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['The formula $x^2 + y^2 = r^2$ describes a circle']);
    });

    it('should normalize display math delimiters in reasoning-delta', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: String.raw`\[E = mc^2\]` },
        { type: 'reasoning-end', id: 'r1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['$$E = mc^2$$']);
    });
  });

  describe('text-delta chunks', () => {
    it('should normalize inline math delimiters in text-delta', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: String.raw`where \(a\) is the acceleration` },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['where $a$ is the acceleration']);
    });
  });

  describe('no-op', () => {
    it('should pass through deltas without LaTeX delimiters unchanged', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'No math here, just $existing$ delimiters' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['No math here, just $existing$ delimiters']);
    });
  });

  describe('passthrough', () => {
    it('should pass through tool chunks unchanged', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'tool-input-start', toolCallId: 'c1', toolName: 'read_file' },
        { type: 'tool-input-available', toolCallId: 'c1', toolName: 'read_file', input: {} },
      ];

      const results = await processChunks(chunks);

      expect(results).toEqual(chunks);
    });

    it('should pass through error chunks unchanged', async () => {
      const errorChunk: UIMessageChunk = { type: 'error', errorText: 'fail' };

      const results = await processChunks([errorChunk]);

      expect(results).toEqual([errorChunk]);
    });

    it('should pass through lifecycle chunks unchanged', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'start' },
        { type: 'start-step' },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ];

      const results = await processChunks(chunks);

      expect(results).toEqual(chunks);
    });
  });

  describe('mixed blocks', () => {
    it('should normalize both reasoning and text deltas independently', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: String.raw`Thinking about \(x\)` },
        { type: 'reasoning-end', id: 'r1' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: String.raw`The answer is \[y = mx + b\]` },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks);
      const reasoningDeltas = results
        .filter((c): c is UIMessageChunk & { delta: string } => c.type === 'reasoning-delta' && 'delta' in c)
        .map((c) => c.delta);
      const textDeltas = results
        .filter((c): c is UIMessageChunk & { delta: string } => c.type === 'text-delta' && 'delta' in c)
        .map((c) => c.delta);

      expect(reasoningDeltas).toEqual(['Thinking about $x$']);
      expect(textDeltas).toEqual(['The answer is $$y = mx + b$$']);
    });
  });
});
