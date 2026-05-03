import { describe, expect, it } from 'vitest';
import { rpcClientErrorCode, rpcClientErrorCodeSchema } from '#schemas/rpc.schema.js';

describe('rpcClientErrorCodeSchema', () => {
  it('should parse FILE_NOT_FOUND', () => {
    expect(rpcClientErrorCodeSchema.parse('FILE_NOT_FOUND')).toBe('FILE_NOT_FOUND');
  });

  it('should parse NO_TOP_LEVEL_GEOMETRY', () => {
    expect(rpcClientErrorCodeSchema.parse('NO_TOP_LEVEL_GEOMETRY')).toBe('NO_TOP_LEVEL_GEOMETRY');
  });

  it('should parse RENDER_TIMEOUT for runtime render-timeout failures', () => {
    expect(rpcClientErrorCodeSchema.parse('RENDER_TIMEOUT')).toBe('RENDER_TIMEOUT');
  });

  it('should still expose UNKNOWN as a generic catch-all', () => {
    expect(rpcClientErrorCodeSchema.parse('UNKNOWN')).toBe('UNKNOWN');
  });
});

describe('rpcClientErrorCode', () => {
  it('should enumerate every schema enum member exactly once', () => {
    const fromObject = new Set(Object.values(rpcClientErrorCode));
    expect(fromObject.size).toBe(rpcClientErrorCodeSchema.options.length);
    for (const code of rpcClientErrorCodeSchema.options) {
      expect(fromObject.has(code)).toBe(true);
    }
  });
});
