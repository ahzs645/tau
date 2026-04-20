import type { ReasoningUIPart } from 'ai';
import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  commonReasoningMetadataSchema,
  getReasoningStartedAtMs,
  getReasoningEndedAtMs,
  getReasoningDurationMs,
} from '#schemas/common-reasoning-metadata.schema.js';
import type { CommonReasoningMetadata } from '#schemas/common-reasoning-metadata.schema.js';

const makePart = (providerMetadata?: ReasoningUIPart['providerMetadata']): ReasoningUIPart => ({
  type: 'reasoning',
  text: 'thinking…',
  state: 'done',
  providerMetadata,
});

describe('commonReasoningMetadataSchema', () => {
  it('should accept an empty object (both endpoints optional)', () => {
    const result = commonReasoningMetadataSchema.safeParse({});

    expect(result.success).toBe(true);
    expect(result.data).toEqual({});
  });

  it('should accept both endpoints when present as positive integers', () => {
    const result = commonReasoningMetadataSchema.safeParse({
      reasoningStartedAtMs: 1_700_000_000_000,
      reasoningEndedAtMs: 1_700_000_002_000,
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      reasoningStartedAtMs: 1_700_000_000_000,
      reasoningEndedAtMs: 1_700_000_002_000,
    });
  });

  it('should reject negative timestamps', () => {
    const result = commonReasoningMetadataSchema.safeParse({ reasoningStartedAtMs: -1 });

    expect(result.success).toBe(false);
  });

  it('should reject non-integer timestamps', () => {
    const result = commonReasoningMetadataSchema.safeParse({ reasoningStartedAtMs: 1.5 });

    expect(result.success).toBe(false);
  });

  it('should reject string timestamps', () => {
    const result = commonReasoningMetadataSchema.safeParse({ reasoningStartedAtMs: 'oops' });

    expect(result.success).toBe(false);
  });
});

describe('CommonReasoningMetadata type', () => {
  it('should expose both endpoints as optional numbers', () => {
    expectTypeOf<CommonReasoningMetadata>().toEqualTypeOf<{
      reasoningStartedAtMs?: number | undefined;
      reasoningEndedAtMs?: number | undefined;
    }>();
  });
});

describe('getReasoningStartedAtMs', () => {
  it('should return the integer when present', () => {
    const part = makePart({ common: { reasoningStartedAtMs: 1_700_000_000_000 } });

    expect(getReasoningStartedAtMs(part)).toBe(1_700_000_000_000);
  });

  it('should return undefined when providerMetadata is missing', () => {
    expect(getReasoningStartedAtMs(makePart())).toBeUndefined();
  });

  it('should return undefined when common namespace is absent', () => {
    const part = makePart({ anthropic: { thinkingSignature: 'abc' } });

    expect(getReasoningStartedAtMs(part)).toBeUndefined();
  });

  it('should return undefined when common.reasoningStartedAtMs is missing', () => {
    const part = makePart({ common: { reasoningEndedAtMs: 1_700_000_001_000 } });

    expect(getReasoningStartedAtMs(part)).toBeUndefined();
  });

  it('should return undefined when the value is malformed', () => {
    const part = makePart({ common: { reasoningStartedAtMs: 'oops' } });

    expect(getReasoningStartedAtMs(part)).toBeUndefined();
  });
});

describe('getReasoningEndedAtMs', () => {
  it('should return the integer when present', () => {
    const part = makePart({ common: { reasoningEndedAtMs: 1_700_000_002_000 } });

    expect(getReasoningEndedAtMs(part)).toBe(1_700_000_002_000);
  });

  it('should return undefined when missing', () => {
    expect(getReasoningEndedAtMs(makePart())).toBeUndefined();
  });

  it('should return undefined when the value is negative', () => {
    const part = makePart({ common: { reasoningEndedAtMs: -10 } });

    expect(getReasoningEndedAtMs(part)).toBeUndefined();
  });
});

describe('getReasoningDurationMs', () => {
  it('should return the difference when both endpoints are present', () => {
    const part = makePart({
      common: {
        reasoningStartedAtMs: 1_700_000_000_000,
        reasoningEndedAtMs: 1_700_000_002_500,
      },
    });

    expect(getReasoningDurationMs(part)).toBe(2500);
  });

  it('should return undefined when reasoningStartedAtMs is missing', () => {
    const part = makePart({ common: { reasoningEndedAtMs: 1_700_000_002_000 } });

    expect(getReasoningDurationMs(part)).toBeUndefined();
  });

  it('should return undefined when reasoningEndedAtMs is missing', () => {
    const part = makePart({ common: { reasoningStartedAtMs: 1_700_000_000_000 } });

    expect(getReasoningDurationMs(part)).toBeUndefined();
  });

  it('should return undefined when providerMetadata is missing entirely', () => {
    expect(getReasoningDurationMs(makePart())).toBeUndefined();
  });

  it('should clamp to 0 when reasoningEndedAtMs precedes reasoningStartedAtMs (NTP backwards-jump)', () => {
    const part = makePart({
      common: {
        reasoningStartedAtMs: 1_700_000_005_000,
        reasoningEndedAtMs: 1_700_000_004_000,
      },
    });

    expect(getReasoningDurationMs(part)).toBe(0);
  });

  it('should ignore unrelated keys in the common namespace (forward compat)', () => {
    const part = makePart({
      common: {
        reasoningStartedAtMs: 1_700_000_000_000,
        reasoningEndedAtMs: 1_700_000_001_000,
        firstTokenAtMs: 1_700_000_000_500,
      },
    });

    expect(getReasoningDurationMs(part)).toBe(1000);
  });

  it('should preserve sibling provider namespaces (e.g. anthropic) without affecting derivation', () => {
    const part = makePart({
      anthropic: { thinkingSignature: 'abc' },
      common: {
        reasoningStartedAtMs: 1_700_000_000_000,
        reasoningEndedAtMs: 1_700_000_001_000,
      },
    });

    expect(getReasoningDurationMs(part)).toBe(1000);
  });
});
