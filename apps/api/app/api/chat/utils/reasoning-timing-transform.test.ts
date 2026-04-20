import type { UIMessage, UIMessageChunk } from 'ai';
import { readUIMessageStream } from 'ai';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createReasoningTimingTransform } from '#api/chat/utils/reasoning-timing-transform.js';
import { createNewlineTrimTransform } from '#api/chat/utils/newline-trim-transform.js';

const drain = async (
  reader: ReadableStreamDefaultReader<UIMessageChunk>,
  accumulator: UIMessageChunk[] = [],
): Promise<UIMessageChunk[]> => {
  const result = await reader.read();
  if (result.done) {
    return accumulator;
  }
  accumulator.push(result.value);
  return drain(reader, accumulator);
};

const pipeChunks = async (
  chunks: UIMessageChunk[],
  transform: TransformStream<UIMessageChunk, UIMessageChunk> = createReasoningTimingTransform(),
): Promise<UIMessageChunk[]> => {
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
  return drain(reader);
};

const findChunk = <T extends UIMessageChunk['type']>(
  chunks: UIMessageChunk[],
  type: T,
  id?: string,
): Extract<UIMessageChunk, { type: T }> => {
  const match = chunks.find(
    (c): c is Extract<UIMessageChunk, { type: T }> =>
      c.type === type && (id === undefined || ('id' in c && c.id === id)),
  );
  if (!match) {
    throw new Error(`expected chunk type ${type}${id ? ` id=${id}` : ''}`);
  }
  return match;
};

const readCommon = (chunk: UIMessageChunk): { reasoningStartedAtMs?: number; reasoningEndedAtMs?: number } => {
  if (!('providerMetadata' in chunk) || !chunk.providerMetadata) {
    throw new Error('chunk has no providerMetadata');
  }
  const namespace = chunk.providerMetadata['common'];
  if (!namespace || typeof namespace !== 'object') {
    throw new Error('chunk has no common namespace');
  }
  const started = (namespace as Record<string, unknown>)['reasoningStartedAtMs'];
  const ended = (namespace as Record<string, unknown>)['reasoningEndedAtMs'];
  return {
    reasoningStartedAtMs: typeof started === 'number' ? started : undefined,
    reasoningEndedAtMs: typeof ended === 'number' ? ended : undefined,
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('createReasoningTimingTransform', () => {
  // ===========================================================================
  // Stamping reasoning-start / reasoning-end
  // ===========================================================================

  describe('stamping reasoning-start', () => {
    it('should stamp providerMetadata.common.reasoningStartedAtMs on reasoning-start', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));
      const expected = Date.now();

      const out = await pipeChunks([{ type: 'reasoning-start', id: 'r1' }]);

      const stamped = findChunk(out, 'reasoning-start', 'r1');
      expect(readCommon(stamped).reasoningStartedAtMs).toBe(expected);
    });

    it('should stamp a positive integer reasoningStartedAtMs (real clock sanity check)', async () => {
      const before = Date.now();
      const out = await pipeChunks([{ type: 'reasoning-start', id: 'r1' }]);
      const after = Date.now();

      const value = readCommon(findChunk(out, 'reasoning-start', 'r1')).reasoningStartedAtMs;
      expect(value).toBeGreaterThanOrEqual(before);
      expect(value).toBeLessThanOrEqual(after);
      expect(Number.isInteger(value)).toBe(true);
    });
  });

  describe('stamping reasoning-end', () => {
    it('should stamp providerMetadata.common.reasoningEndedAtMs on reasoning-end', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-20T00:00:01Z'));
      const expected = Date.now();

      const out = await pipeChunks([{ type: 'reasoning-end', id: 'r1' }]);

      const stamped = findChunk(out, 'reasoning-end', 'r1');
      expect(readCommon(stamped).reasoningEndedAtMs).toBe(expected);
    });

    it('should stamp reasoningEndedAtMs >= reasoningStartedAtMs across a start/end pair', async () => {
      const out = await pipeChunks([
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-end', id: 'r1' },
      ]);

      const startedAt = readCommon(findChunk(out, 'reasoning-start', 'r1')).reasoningStartedAtMs ?? -1;
      const endedAt = readCommon(findChunk(out, 'reasoning-end', 'r1')).reasoningEndedAtMs ?? -1;
      expect(endedAt).toBeGreaterThanOrEqual(startedAt);
    });

    it('should carry the matching reasoningStartedAtMs forward onto the reasoning-end chunk (Finding 8)', async () => {
      // The minimal-state transform must re-stamp reasoningStartedAtMs on
      // reasoning-end (looked up from the per-stream map keyed by chunk id)
      // because the AI SDK's processUIMessageStream reducer replaces
      // ReasoningUIPart.providerMetadata on every chunk that carries one.
      // Without this, the start timestamp is silently overwritten and the
      // assembled UI part has no derivable duration.
      const out = await pipeChunks([
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'thinking' },
        { type: 'reasoning-end', id: 'r1' },
      ]);

      const startedOnStartChunk = readCommon(findChunk(out, 'reasoning-start', 'r1')).reasoningStartedAtMs;
      const endChunkCommon = readCommon(findChunk(out, 'reasoning-end', 'r1'));
      expect(startedOnStartChunk).toBeTypeOf('number');
      expect(endChunkCommon.reasoningStartedAtMs).toBe(startedOnStartChunk);
      expect(endChunkCommon.reasoningEndedAtMs).toBeTypeOf('number');
    });

    it('should stamp reasoningEndedAtMs but OMIT reasoningStartedAtMs for an unmatched reasoning-end (no fabrication)', async () => {
      // Clean contract: when no matching reasoning-start was seen, we emit
      // only the end timestamp. The client's getReasoningDurationMs returns
      // undefined and the UI falls back to "Thought process" — same
      // observable behaviour as a pre-instrumentation persisted part. We
      // deliberately do NOT fabricate a startedAtMs.
      const out = await pipeChunks([{ type: 'reasoning-end', id: 'orphan' }]);

      const common = readCommon(findChunk(out, 'reasoning-end', 'orphan'));
      expect(common.reasoningEndedAtMs).toBeTypeOf('number');
      expect(common.reasoningStartedAtMs).toBeUndefined();
    });
  });

  // ===========================================================================
  // Pass-through guarantees (locks non-blocking + minimal-state)
  // ===========================================================================

  describe('reasoning-delta pass-through (non-blocking guarantee)', () => {
    it('should forward reasoning-delta chunks structurally identical to input (no metadata mutation)', async () => {
      const delta: UIMessageChunk = { type: 'reasoning-delta', id: 'r1', delta: 'thinking' };
      const out = await pipeChunks([delta]);

      const forwarded = findChunk(out, 'reasoning-delta', 'r1');
      expect(forwarded).toEqual(delta);
    });

    it('should forward reasoning-delta as the same reference (zero-copy hot path)', async () => {
      const delta: UIMessageChunk = { type: 'reasoning-delta', id: 'r1', delta: 'thinking' };
      const out = await pipeChunks([delta]);

      const forwarded = findChunk(out, 'reasoning-delta', 'r1');
      expect(forwarded).toBe(delta);
    });

    it('should forward many reasoning-delta chunks in order without dropping or coalescing', async () => {
      const deltas: UIMessageChunk[] = Array.from({ length: 20 }, (_, i) => ({
        type: 'reasoning-delta',
        id: 'r1',
        delta: `chunk-${i}`,
      }));
      const out = await pipeChunks(deltas);

      const observedDeltas = out
        .filter((c) => c.type === 'reasoning-delta')
        .map((c) => (c as UIMessageChunk & { delta: string }).delta);
      expect(observedDeltas).toEqual(deltas.map((d) => (d as UIMessageChunk & { delta: string }).delta));
    });
  });

  describe('non-reasoning chunks pass-through', () => {
    it('should forward text-start, text-delta, text-end, tool-input-delta, finish unchanged', async () => {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'hello' },
        { type: 'text-end', id: 't1' },
        { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"x":1}' },
        { type: 'finish' },
      ];

      const out = await pipeChunks(chunks);

      expect(out).toEqual(chunks);
    });
  });

  // ===========================================================================
  // Minimal-state behaviour: per-stream Map<id, startedAtMs> isolation,
  // drain on reasoning-end, and no cross-block contamination on interleaved
  // streams. The map exists solely to carry reasoningStartedAtMs forward to
  // the matching reasoning-end (Finding 8); these tests pin its semantics.
  // ===========================================================================

  describe('minimal-state behaviour (per-stream Map<id, startedAtMs>)', () => {
    it('should stamp independent timestamps for sequential reasoning blocks across distinct transform instances', async () => {
      // Each transform-instance call to Date.now() yields a fresh stamp;
      // the spy increments per call so the four invocations across the
      // two streams produce four distinct values.
      const stamps = [100_000, 200_000, 5_100_000, 5_200_000];
      let i = 0;
      const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
        const value = stamps.at(i) ?? stamps.at(-1)!;
        i += 1;
        return value;
      });

      try {
        const out1 = await pipeChunks(
          [
            { type: 'reasoning-start', id: 'r1' },
            { type: 'reasoning-end', id: 'r1' },
          ],
          createReasoningTimingTransform(),
        );

        const out2 = await pipeChunks(
          [
            { type: 'reasoning-start', id: 'r2' },
            { type: 'reasoning-end', id: 'r2' },
          ],
          createReasoningTimingTransform(),
        );

        const r1Start = readCommon(findChunk(out1, 'reasoning-start', 'r1')).reasoningStartedAtMs;
        const r2Start = readCommon(findChunk(out2, 'reasoning-start', 'r2')).reasoningStartedAtMs;
        expect(r1Start).toBe(100_000);
        expect(r2Start).toBe(5_100_000);
      } finally {
        dateNowSpy.mockRestore();
      }
    });

    it('should pair each reasoning-end with its own reasoning-start on interleaved blocks (no cross-contamination)', async () => {
      // Two interleaved blocks: each reasoning-end must carry the
      // reasoningStartedAtMs of its matching reasoning-start (looked up by
      // chunk id), and never another block's value. We spy on Date.now so
      // each successive transform call sees a distinct timestamp — the
      // WHATWG TransformStream processes queued chunks back-to-back, so
      // wall-clock or `vi.advanceTimersByTime` from `start()` would not
      // produce distinct stamps at transform-time.
      const stamps = [1000, 2000, 3000, 4000];
      let i = 0;
      const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
        const value = stamps.at(i) ?? stamps.at(-1)!;
        i += 1;
        return value;
      });

      try {
        const out = await pipeChunks([
          { type: 'reasoning-start', id: 'A' }, // Date.now() -> 1000
          { type: 'reasoning-start', id: 'B' }, // Date.now() -> 2000
          { type: 'reasoning-end', id: 'A' }, //   Date.now() -> 3000
          { type: 'reasoning-end', id: 'B' }, //   Date.now() -> 4000
        ]);

        const aStartCommon = readCommon(findChunk(out, 'reasoning-start', 'A'));
        const bStartCommon = readCommon(findChunk(out, 'reasoning-start', 'B'));
        const aEndCommon = readCommon(findChunk(out, 'reasoning-end', 'A'));
        const bEndCommon = readCommon(findChunk(out, 'reasoning-end', 'B'));

        expect(aStartCommon.reasoningStartedAtMs).toBe(1000);
        expect(bStartCommon.reasoningStartedAtMs).toBe(2000);

        // The crucial assertion: each end carries the start of its OWN id.
        expect(aEndCommon.reasoningStartedAtMs).toBe(1000);
        expect(bEndCommon.reasoningStartedAtMs).toBe(2000);
        expect(aEndCommon.reasoningEndedAtMs).toBe(3000);
        expect(bEndCommon.reasoningEndedAtMs).toBe(4000);
      } finally {
        dateNowSpy.mockRestore();
      }
    });

    it('should not share Map state across distinct TransformStream instances (per-stream isolation)', async () => {
      // Instantiate the transform twice. Pump reasoning-start id=r1 through
      // instance A and reasoning-end id=r1 through instance B. Instance B
      // must NOT fabricate a reasoningStartedAtMs from instance A's map.
      const instanceA = createReasoningTimingTransform();
      const instanceB = createReasoningTimingTransform();

      const outA = await pipeChunks([{ type: 'reasoning-start', id: 'r1' }], instanceA);
      const outB = await pipeChunks([{ type: 'reasoning-end', id: 'r1' }], instanceB);

      expect(readCommon(findChunk(outA, 'reasoning-start', 'r1')).reasoningStartedAtMs).toBeTypeOf('number');

      const bEnd = readCommon(findChunk(outB, 'reasoning-end', 'r1'));
      expect(bEnd.reasoningEndedAtMs).toBeTypeOf('number');
      // Instance B never saw the reasoning-start, so its end is unmatched.
      expect(bEnd.reasoningStartedAtMs).toBeUndefined();
    });

    it('should drain the Map on reasoning-end so each pair gets its own matching start (memory-leak / state-reuse guard)', async () => {
      // Pump start+end for the same id twice in the same stream. Each
      // reasoning-end must carry the startedAtMs of its MATCHING start
      // (the second pair gets the second start's timestamp, not a stale
      // value carried over from the first start). This locks the Map's
      // "delete on reasoning-end" contract.
      const stamps = [10_000, 11_000, 13_000, 14_000];
      let i = 0;
      const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
        const value = stamps.at(i) ?? stamps.at(-1)!;
        i += 1;
        return value;
      });

      try {
        const out = await pipeChunks([
          { type: 'reasoning-start', id: 'r1' }, // 10_000
          { type: 'reasoning-end', id: 'r1' }, //   11_000
          { type: 'reasoning-start', id: 'r1' }, // 13_000
          { type: 'reasoning-end', id: 'r1' }, //   14_000
        ]);

        const startChunks = out.filter((c) => c.type === 'reasoning-start');
        const endChunks = out.filter((c) => c.type === 'reasoning-end');
        expect(startChunks).toHaveLength(2);
        expect(endChunks).toHaveLength(2);

        const firstStart = readCommon(startChunks[0]!).reasoningStartedAtMs;
        const secondStart = readCommon(startChunks[1]!).reasoningStartedAtMs;
        const firstEnd = readCommon(endChunks[0]!);
        const secondEnd = readCommon(endChunks[1]!);

        expect(firstStart).toBe(10_000);
        expect(secondStart).toBe(13_000);
        // First end pairs with first start; second end pairs with second start.
        expect(firstEnd.reasoningStartedAtMs).toBe(10_000);
        expect(firstEnd.reasoningEndedAtMs).toBe(11_000);
        expect(secondEnd.reasoningStartedAtMs).toBe(13_000);
        expect(secondEnd.reasoningEndedAtMs).toBe(14_000);
        // Cross-pairing would be a memory-leak / state-reuse bug.
        expect(secondEnd.reasoningStartedAtMs).not.toBe(firstStart);
      } finally {
        dateNowSpy.mockRestore();
      }
    });
  });

  // ===========================================================================
  // Provider metadata preservation
  // ===========================================================================

  describe('provider metadata preservation', () => {
    it('should preserve sibling provider namespaces (anthropic) when stamping common on reasoning-start', async () => {
      const out = await pipeChunks([
        {
          type: 'reasoning-start',
          id: 'r1',
          providerMetadata: { anthropic: { thinkingSignature: 'abc' } },
        },
      ]);

      const stamped = findChunk(out, 'reasoning-start', 'r1');
      expect(stamped.providerMetadata?.['anthropic']).toEqual({ thinkingSignature: 'abc' });
      expect(readCommon(stamped).reasoningStartedAtMs).toBeTypeOf('number');
    });

    it('should preserve sibling provider namespaces when stamping common on reasoning-end', async () => {
      const out = await pipeChunks([
        {
          type: 'reasoning-end',
          id: 'r1',
          providerMetadata: { anthropic: { thinkingSignature: 'xyz' } },
        },
      ]);

      const stamped = findChunk(out, 'reasoning-end', 'r1');
      expect(stamped.providerMetadata?.['anthropic']).toEqual({ thinkingSignature: 'xyz' });
      expect(readCommon(stamped).reasoningEndedAtMs).toBeTypeOf('number');
    });

    it('should merge with an upstream-provided common namespace without clobbering its other keys', async () => {
      const out = await pipeChunks([
        {
          type: 'reasoning-start',
          id: 'r1',
          providerMetadata: { common: { firstTokenAtMs: 12_345 } },
        },
      ]);

      const stamped = findChunk(out, 'reasoning-start', 'r1');
      const namespace = stamped.providerMetadata?.['common'] as Record<string, unknown> | undefined;
      expect(namespace?.['firstTokenAtMs']).toBe(12_345);
      expect(namespace?.['reasoningStartedAtMs']).toBeTypeOf('number');
    });
  });

  // ===========================================================================
  // Synchronous emission (no microtask delays)
  // ===========================================================================

  describe('synchronous emission', () => {
    it('should emit a stamped reasoning-start within the same microtask as the source enqueue', async () => {
      const transform = createReasoningTimingTransform();
      const reader = new ReadableStream<UIMessageChunk>({
        start(controller) {
          controller.enqueue({ type: 'reasoning-start', id: 'r1' });
          controller.close();
        },
      })
        .pipeThrough(transform)
        .getReader();

      const result = await reader.read();
      expect(result.done).toBe(false);
      if (result.done) {
        return;
      }
      expect(result.value.type).toBe('reasoning-start');
    });
  });

  // ===========================================================================
  // Composition with downstream transforms (R5 wiring smoke check)
  // ===========================================================================

  describe('downstream composition (R5 wiring smoke check)', () => {
    it('should preserve common timing metadata when piped through createNewlineTrimTransform', async () => {
      const composed = new ReadableStream<UIMessageChunk>({
        start(controller) {
          controller.enqueue({ type: 'reasoning-start', id: 'r1' });
          controller.enqueue({ type: 'reasoning-delta', id: 'r1', delta: 'first' });
          controller.enqueue({ type: 'reasoning-end', id: 'r1' });
          controller.close();
        },
      })
        .pipeThrough(createReasoningTimingTransform())
        .pipeThrough(createNewlineTrimTransform())
        .getReader();

      const composedOut = await drain(composed);
      expect(readCommon(findChunk(composedOut, 'reasoning-start', 'r1')).reasoningStartedAtMs).toBeTypeOf('number');
      expect(readCommon(findChunk(composedOut, 'reasoning-end', 'r1')).reasoningEndedAtMs).toBeTypeOf('number');
    });
  });

  // ===========================================================================
  // End-to-end through AI SDK reducer (Finding 8 regression)
  // ===========================================================================
  //
  // The AI SDK's `processUIMessageStream` reducer REPLACES
  // `ReasoningUIPart.providerMetadata` on every chunk that supplies one,
  // rather than deep-merging it. So if our transform stamps only
  // `reasoningEndedAtMs` on `reasoning-end`, the `reasoningStartedAtMs` from
  // `reasoning-start` is silently overwritten and the assembled UI part
  // ends up with no derivable duration. These tests exercise the reducer
  // path directly (via the publicly-exported `readUIMessageStream`) so the
  // contract is locked in at the layer that was actually broken in
  // production.

  describe('end-to-end through AI SDK reducer (Finding 8 regression)', () => {
    const collectFinalMessage = async (chunks: UIMessageChunk[]): Promise<UIMessage> => {
      const wire = new ReadableStream<UIMessageChunk>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }).pipeThrough(createReasoningTimingTransform());

      let last: UIMessage | undefined;
      for await (const message of readUIMessageStream({ stream: wire })) {
        last = message;
      }
      if (!last) {
        throw new Error('readUIMessageStream produced no message');
      }
      return last;
    };

    const findReasoningPart = (message: UIMessage) => {
      const part = message.parts.find((p) => p.type === 'reasoning');
      if (part?.type !== 'reasoning') {
        throw new Error('assembled message had no reasoning part');
      }
      return part;
    };

    it('should preserve both reasoningStartedAtMs and reasoningEndedAtMs on the assembled ReasoningUIPart after the reducer runs', async () => {
      const message = await collectFinalMessage([
        { type: 'start', messageId: 'm1' },
        { type: 'start-step' },
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'thinking' },
        { type: 'reasoning-end', id: 'r1' },
        { type: 'finish-step' },
        { type: 'finish' },
      ]);

      const part = findReasoningPart(message);
      const common = part.providerMetadata?.['common'] as Record<string, unknown> | undefined;
      expect(common?.['reasoningStartedAtMs']).toBeTypeOf('number');
      expect(common?.['reasoningEndedAtMs']).toBeTypeOf('number');
      expect(common?.['reasoningEndedAtMs'] as number).toBeGreaterThanOrEqual(
        common?.['reasoningStartedAtMs'] as number,
      );
    });

    it('should preserve both timestamps independently for each reasoning part when a message has multiple reasoning blocks', async () => {
      const message = await collectFinalMessage([
        { type: 'start', messageId: 'm1' },
        { type: 'start-step' },
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'first' },
        { type: 'reasoning-end', id: 'r1' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'mid-text' },
        { type: 'text-end', id: 't1' },
        { type: 'reasoning-start', id: 'r2' },
        { type: 'reasoning-delta', id: 'r2', delta: 'second' },
        { type: 'reasoning-end', id: 'r2' },
        { type: 'finish-step' },
        { type: 'finish' },
      ]);

      const reasoningParts = message.parts.filter((p) => p.type === 'reasoning');
      expect(reasoningParts).toHaveLength(2);
      for (const part of reasoningParts) {
        const common = part.providerMetadata?.['common'] as Record<string, unknown> | undefined;
        expect(common?.['reasoningStartedAtMs']).toBeTypeOf('number');
        expect(common?.['reasoningEndedAtMs']).toBeTypeOf('number');
      }
    });
  });
});
