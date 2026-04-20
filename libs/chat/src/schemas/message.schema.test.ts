import type { ReasoningUIPart } from 'ai';
import { describe, it, expect, expectTypeOf } from 'vitest';
import { uiMessagesSchema } from '#schemas/message.schema.js';
import type { MyUIMessage, MyMessagePart } from '#types/message.types.js';
import type { CommonReasoningMetadata } from '#schemas/common-reasoning-metadata.schema.js';

const baseMessage = (parts: MyUIMessage['parts']): MyUIMessage => ({
  id: 'm1',
  role: 'assistant',
  parts,
});

const reasoningPart = (
  providerMetadata?: ReasoningUIPart['providerMetadata'],
  state: 'streaming' | 'done' = 'done',
): MyUIMessage['parts'][number] => ({
  type: 'reasoning',
  text: 'thinking…',
  state,
  providerMetadata,
});

const findReasoning = (parts: readonly MyMessagePart[]): MyMessagePart & { type: 'reasoning' } => {
  const part = parts.find((p): p is MyMessagePart & { type: 'reasoning' } => p.type === 'reasoning');
  if (!part) {
    throw new Error('expected a reasoning part');
  }
  return part;
};

describe('uiMessagesSchema reasoning part narrowing', () => {
  describe('backwards compatibility', () => {
    it('should accept a legacy persisted reasoning part with no providerMetadata', () => {
      const result = uiMessagesSchema.safeParse([baseMessage([reasoningPart()])]);

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      const part = findReasoning(result.data[0]?.parts ?? []);
      expect(part.providerMetadata).toBeUndefined();
    });

    it('should preserve a legacy provider-only namespace (anthropic) with no common keys', () => {
      const result = uiMessagesSchema.safeParse([
        baseMessage([reasoningPart({ anthropic: { thinkingSignature: 'abc' } })]),
      ]);

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      const part = findReasoning(result.data[0]?.parts ?? []);
      expect(part.providerMetadata).toEqual({ anthropic: { thinkingSignature: 'abc' } });
    });

    it('should accept reasoning parts in mixed messages with text parts and no metadata', () => {
      const result = uiMessagesSchema.safeParse([
        baseMessage([reasoningPart(), { type: 'text', text: 'Hello', state: 'done' }]),
      ]);

      expect(result.success).toBe(true);
    });
  });

  describe('common namespace acceptance', () => {
    it('should accept and preserve typed reasoningStartedAtMs and reasoningEndedAtMs', () => {
      const result = uiMessagesSchema.safeParse([
        baseMessage([
          reasoningPart({
            common: {
              reasoningStartedAtMs: 1_700_000_000_000,
              reasoningEndedAtMs: 1_700_000_002_000,
            },
          }),
        ]),
      ]);

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      const part = findReasoning(result.data[0]?.parts ?? []);
      expect(part.providerMetadata).toEqual({
        common: {
          reasoningStartedAtMs: 1_700_000_000_000,
          reasoningEndedAtMs: 1_700_000_002_000,
        },
      });
    });

    it('should accept mixed common + anthropic namespaces and retain both', () => {
      const result = uiMessagesSchema.safeParse([
        baseMessage([
          reasoningPart({
            common: {
              reasoningStartedAtMs: 1_700_000_000_000,
              reasoningEndedAtMs: 1_700_000_001_000,
            },
            anthropic: { thinkingSignature: 'abc' },
          }),
        ]),
      ]);

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      const part = findReasoning(result.data[0]?.parts ?? []);
      expect(part.providerMetadata).toEqual({
        common: {
          reasoningStartedAtMs: 1_700_000_000_000,
          reasoningEndedAtMs: 1_700_000_001_000,
        },
        anthropic: { thinkingSignature: 'abc' },
      });
    });

    it('should accept common containing only one endpoint (in-progress block)', () => {
      const result = uiMessagesSchema.safeParse([
        baseMessage([reasoningPart({ common: { reasoningStartedAtMs: 1_700_000_000_000 } }, 'streaming')]),
      ]);

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      const part = findReasoning(result.data[0]?.parts ?? []);
      expect(part.providerMetadata).toEqual({ common: { reasoningStartedAtMs: 1_700_000_000_000 } });
    });
  });

  describe('common namespace rejection', () => {
    it('should reject a negative reasoningStartedAtMs', () => {
      const result = uiMessagesSchema.safeParse([
        baseMessage([reasoningPart({ common: { reasoningStartedAtMs: -1 } })]),
      ]);

      expect(result.success).toBe(false);
      if (result.success) {
        return;
      }
      expect(result.error.issues.some((issue) => issue.path.includes('reasoningStartedAtMs'))).toBe(true);
    });

    it('should reject a string reasoningStartedAtMs', () => {
      const result = uiMessagesSchema.safeParse([
        baseMessage([reasoningPart({ common: { reasoningStartedAtMs: 'oops' } })]),
      ]);

      expect(result.success).toBe(false);
    });

    it('should reject a non-integer reasoningEndedAtMs', () => {
      const result = uiMessagesSchema.safeParse([
        baseMessage([reasoningPart({ common: { reasoningEndedAtMs: 1.5 } })]),
      ]);

      expect(result.success).toBe(false);
    });
  });

  describe('type-level narrowing', () => {
    it('should treat the typed common namespace as assignable to MyMessagePart reasoning providerMetadata', () => {
      const typedCommon: { common: CommonReasoningMetadata } = {
        common: {
          reasoningStartedAtMs: 1_700_000_000_000,
          reasoningEndedAtMs: 1_700_000_001_000,
        },
      };
      const part: MyMessagePart = {
        type: 'reasoning',
        text: 'hello',
        state: 'done',
        providerMetadata: typedCommon,
      };

      expect(part.providerMetadata).toEqual(typedCommon);
      expectTypeOf<CommonReasoningMetadata>().toExtend<{
        reasoningStartedAtMs?: number | undefined;
        reasoningEndedAtMs?: number | undefined;
      }>();
    });
  });
});
