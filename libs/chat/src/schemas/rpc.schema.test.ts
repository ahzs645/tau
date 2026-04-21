import { describe, expect, it } from 'vitest';
import { rpcClientErrorCodeSchema } from '#schemas/rpc.schema.js';

describe('rpcClientErrorCodeSchema', () => {
  it('should parse FILE_NOT_FOUND', () => {
    expect(rpcClientErrorCodeSchema.parse('FILE_NOT_FOUND')).toBe('FILE_NOT_FOUND');
  });

  it('should parse NO_TOP_LEVEL_GEOMETRY', () => {
    expect(rpcClientErrorCodeSchema.parse('NO_TOP_LEVEL_GEOMETRY')).toBe('NO_TOP_LEVEL_GEOMETRY');
  });

  it('should still expose UNKNOWN as a generic catch-all', () => {
    expect(rpcClientErrorCodeSchema.parse('UNKNOWN')).toBe('UNKNOWN');
  });
});
