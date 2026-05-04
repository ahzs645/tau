/**
 * R2 — `extractInlineFileSystem` behaviour for opaque {@link RuntimeFileSystem} handles.
 */

import { describe, it, expect } from 'vitest';

import { fromMemoryFs } from '#filesystem/runtime-filesystem.js';
import { extractInlineFileSystem, wrapAsRuntimeFileSystem } from '#transport/_internal/runtime-filesystem-handle.js';

describe('extractInlineFileSystem (R2)', () => {
  it('should return undefined when fs is undefined', () => {
    expect(extractInlineFileSystem(undefined)).toBeUndefined();
  });

  it('should return the underlying RuntimeFileSystemBase for inline fs created via fromMemoryFs', async () => {
    const pathA = '/a.txt';
    const opaque = fromMemoryFs({ [pathA]: 'x' });
    const base = extractInlineFileSystem(opaque);
    expect(base).toBeDefined();
    await expect(base!.readFile(pathA, 'utf8')).resolves.toBe('x');
  });

  it('should throw a TypeError with expected message for channel bridged opaque fs', async () => {
    const pair = new MessageChannel();
    const channelFs = wrapAsRuntimeFileSystem({
      kind: 'channel',
      port: pair.port2,
      dispose(): void {
        pair.port2.close();
      },
    });

    expect(() => extractInlineFileSystem(channelFs)).toThrow(TypeError);
    try {
      extractInlineFileSystem(channelFs);
      expect.fail('should have thrown');
    } catch (error) {
      expect((error as Error).message).toBe(`extractInlineFileSystem: expected inline fs, received 'channel'`);
    }
    pair.port1.close();
  });
});
