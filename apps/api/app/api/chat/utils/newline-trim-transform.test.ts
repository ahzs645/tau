import type { UIMessageChunk } from 'ai';
import { describe, it, expect } from 'vitest';
import { createNewlineTrimTransform } from '#api/chat/utils/newline-trim-transform.js';

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
 * Helper to process chunks through the newline trim transform.
 */
async function processChunks(chunks: UIMessageChunk[]): Promise<UIMessageChunk[]> {
  const transform = createNewlineTrimTransform();
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

/**
 * Extracts delta strings from an array of chunks, filtering to delta types only.
 */
function extractDeltas(chunks: UIMessageChunk[]): string[] {
  return chunks
    .filter((c): c is UIMessageChunk & { delta: string } => 'delta' in c && typeof c.delta === 'string')
    .map((c) => c.delta);
}

describe('createNewlineTrimTransform', () => {
  // ===========================================================================
  // Leading newlines
  // ===========================================================================

  describe('leading newlines', () => {
    it('should strip leading newline-only deltas at block start', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: '\n\n' },
        { type: 'text-delta', id: 't1', delta: 'Hello' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['Hello']);
    });

    it('should strip leading newlines from the first delta containing content', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: '\n\nHello world' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['Hello world']);
    });

    it('should strip multiple leading newline-only deltas', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: '\n' },
        { type: 'text-delta', id: 't1', delta: '\n' },
        { type: 'text-delta', id: 't1', delta: '\n' },
        { type: 'text-delta', id: 't1', delta: 'Content' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['Content']);
    });
  });

  // ===========================================================================
  // Trailing newlines
  // ===========================================================================

  describe('trailing newlines', () => {
    it('should discard trailing newline-only deltas at block end', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Hello' },
        { type: 'text-delta', id: 't1', delta: '\n\n' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['Hello']);
    });

    it('should discard trailing newlines split across multiple deltas', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Done' },
        { type: 'text-delta', id: 't1', delta: '\n' },
        { type: 'text-delta', id: 't1', delta: '\n' },
        { type: 'text-delta', id: 't1', delta: '\n' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['Done']);
    });
  });

  // ===========================================================================
  // Interior newline collapsing
  // ===========================================================================

  describe('interior newline collapsing', () => {
    it('should collapse 3+ interior newlines to double newline', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Part A' },
        { type: 'text-delta', id: 't1', delta: '\n\n\n\n' },
        { type: 'text-delta', id: 't1', delta: 'Part B' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['Part A', '\n\nPart B']);
    });

    it('should preserve double newlines as-is', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Para 1' },
        { type: 'text-delta', id: 't1', delta: '\n\n' },
        { type: 'text-delta', id: 't1', delta: 'Para 2' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['Para 1', '\n\nPara 2']);
    });

    it('should preserve single newlines as-is', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Line 1' },
        { type: 'text-delta', id: 't1', delta: '\n' },
        { type: 'text-delta', id: 't1', delta: 'Line 2' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['Line 1', '\nLine 2']);
    });

    it('should collapse newlines split across multiple deltas', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'A' },
        { type: 'text-delta', id: 't1', delta: '\n' },
        { type: 'text-delta', id: 't1', delta: '\n' },
        { type: 'text-delta', id: 't1', delta: '\n' },
        { type: 'text-delta', id: 't1', delta: '\n' },
        { type: 'text-delta', id: 't1', delta: 'B' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['A', '\n\nB']);
    });
  });

  // ===========================================================================
  // Reasoning blocks
  // ===========================================================================

  describe('reasoning blocks', () => {
    it('should strip leading newlines from reasoning block', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: '\n\n' },
        { type: 'reasoning-delta', id: 'r1', delta: 'Reviewing the implementation' },
        { type: 'reasoning-end', id: 'r1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['Reviewing the implementation']);
    });

    it('should discard trailing newlines from reasoning block', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'Thinking' },
        { type: 'reasoning-delta', id: 'r1', delta: '\n\n\n' },
        { type: 'reasoning-end', id: 'r1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['Thinking']);
    });

    it('should collapse interior newlines in reasoning block', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'Step 1' },
        { type: 'reasoning-delta', id: 'r1', delta: '\n\n\n\n\n' },
        { type: 'reasoning-delta', id: 'r1', delta: 'Step 2' },
        { type: 'reasoning-end', id: 'r1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['Step 1', '\n\nStep 2']);
    });
  });

  // ===========================================================================
  // Mixed / concurrent blocks
  // ===========================================================================

  describe('mixed blocks', () => {
    it('should maintain independent state for concurrent text and reasoning blocks', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: '\n\nThinking' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: '\n\nResponse' },
        { type: 'reasoning-end', id: 'r1' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks);
      const reasoningDeltas = results
        .filter((c): c is UIMessageChunk & { delta: string } => c.type === 'reasoning-delta' && 'delta' in c)
        .map((c) => c.delta);
      const textDeltas = results
        .filter((c): c is UIMessageChunk & { delta: string } => c.type === 'text-delta' && 'delta' in c)
        .map((c) => c.delta);

      expect(reasoningDeltas).toEqual(['Thinking']);
      expect(textDeltas).toEqual(['Response']);
    });
  });

  // ===========================================================================
  // Passthrough (non-delta chunks)
  // ===========================================================================

  describe('passthrough', () => {
    it('should pass through tool chunks unchanged', async () => {
      const toolStart: UIMessageChunk = { type: 'tool-input-start', toolCallId: 'c1', toolName: 'read_file' };
      const toolAvailable: UIMessageChunk = {
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'read_file',
        input: {},
      };
      const chunks: UIMessageChunk[] = [toolStart, toolAvailable];

      const results = await processChunks(chunks);

      expect(results).toEqual(chunks);
    });

    it('should pass through error chunks unchanged', async () => {
      const errorChunk: UIMessageChunk = { type: 'error', errorText: 'fail' };

      const results = await processChunks([errorChunk]);

      expect(results).toEqual([errorChunk]);
    });

    it('should pass through start/finish lifecycle chunks unchanged', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'start' },
        { type: 'start-step' },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ];

      const results = await processChunks(chunks);

      expect(results).toEqual(chunks);
    });

    it('should pass through text-start and text-end unchanged', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks);

      expect(results).toEqual(chunks);
    });
  });

  // ===========================================================================
  // No-op (clean content)
  // ===========================================================================

  describe('no-op', () => {
    it('should pass through clean text deltas unchanged', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Hello ' },
        { type: 'text-delta', id: 't1', delta: 'world' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['Hello ', 'world']);
    });

    it('should pass through content with preserved double newlines', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Para 1\n\nPara 2' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['Para 1\n\nPara 2']);
    });
  });

  // ===========================================================================
  // Sequential blocks (state reset)
  // ===========================================================================

  describe('sequential blocks', () => {
    it('should reset state between sequential text blocks', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: '\n\nFirst' },
        { type: 'text-end', id: 't1' },
        { type: 'text-start', id: 't2' },
        { type: 'text-delta', id: 't2', delta: '\n\nSecond' },
        { type: 'text-end', id: 't2' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['First', 'Second']);
    });

    it('should handle blocks with only newlines (fully suppressed)', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: '\n\n\n' },
        { type: 'text-end', id: 't1' },
      ];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual([]);
    });
  });

  // ===========================================================================
  // Delta chunks without a tracked block (graceful fallback)
  // ===========================================================================

  describe('untracked deltas', () => {
    it('should pass through delta chunks without a preceding block-start', async () => {
      const chunks: UIMessageChunk[] = [{ type: 'text-delta', id: 'orphan', delta: '\n\nHello' }];

      const results = await processChunks(chunks);
      const deltas = extractDeltas(results);

      expect(deltas).toEqual(['\n\nHello']);
    });
  });
});
