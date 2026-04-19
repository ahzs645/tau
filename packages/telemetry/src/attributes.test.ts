import { describe, it, expect } from 'vitest';
import { AttributeKey, KernelStatus, GenAiToolStatus, GenAiTokenType, RpcStatus } from '#attributes.js';

describe('AttributeKey', () => {
  it('should have unique values across all keys', () => {
    const values = Object.values(AttributeKey);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it('should use dot-separated lowercase notation for all keys', () => {
    for (const value of Object.values(AttributeKey)) {
      expect(value).toMatch(/^[_a-z][\d._a-z]*$/);
    }
  });
});

describe('KernelStatus', () => {
  it('should define success and error values', () => {
    expect(KernelStatus.SUCCESS).toBe('success');
    expect(KernelStatus.ERROR).toBe('error');
  });
});

describe('GenAiToolStatus', () => {
  it('should define success and error values', () => {
    expect(GenAiToolStatus.SUCCESS).toBe('success');
    expect(GenAiToolStatus.ERROR).toBe('error');
  });
});

describe('GenAiTokenType', () => {
  it('should define input and output values', () => {
    expect(GenAiTokenType.INPUT).toBe('input');
    expect(GenAiTokenType.OUTPUT).toBe('output');
  });
});

describe('RpcStatus', () => {
  it('should define ok and error values', () => {
    expect(RpcStatus.OK).toBe('ok');
    expect(RpcStatus.ERROR).toBe('error');
  });
});
