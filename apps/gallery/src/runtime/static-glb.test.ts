import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { normalizeStaticGlb } from '#runtime/static-glb.js';

const glb = (): Uint8Array<ArrayBuffer> => {
  const json = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ translation: [2, 3, 4], mesh: 0 }],
      extensionsUsed: ['EXT_test_preserved'],
      extensions: { EXT_test_preserved: { value: 123 } },
    }),
  );
  const paddedLength = Math.ceil(json.byteLength / 4) * 4;
  const bytes = new Uint8Array(20 + paddedLength + 12);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 0x46_54_6c_67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, bytes.byteLength, true);
  header.setUint32(12, paddedLength, true);
  header.setUint32(16, 0x4e_4f_53_4a, true);
  bytes.fill(0x20, 20, 20 + paddedLength);
  bytes.set(json, 20);
  header.setUint32(20 + paddedLength, 4, true);
  header.setUint32(24 + paddedLength, 0x00_4e_49_42, true);
  bytes.set([9, 8, 7, 6], 28 + paddedLength);
  return bytes;
};

describe('legacy static GLB orientation', () => {
  it('should rotate Z-up metres to Y-up metres while retaining source buffers and extensions', () => {
    const source = glb();
    const converted = normalizeStaticGlb(source, 'z-up');
    const header = new DataView(converted.buffer);
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(converted.subarray(20, 20 + header.getUint32(12, true))),
    );
    expect(parsed).toMatchObject({
      nodes: [
        { translation: [2, 3, 4], mesh: 0 },
        { children: [0], rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
      ],
      scenes: [{ nodes: [1] }],
      extensions: { EXT_test_preserved: { value: 123 } },
    });
    const position = new Vector3(2, 3, 4).applyQuaternion(new Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2));
    expect(position.x).toBeCloseTo(2);
    expect(position.y).toBeCloseTo(4);
    expect(position.z).toBeCloseTo(-3);
    expect(position.length()).toBeCloseTo(Math.sqrt(29));
    expect(converted.subarray(-12)).toEqual(source.subarray(-12));
    expect(normalizeStaticGlb(source, 'y-up')).toBe(source);
  });

  it('should rotate Y-up metres into Z-up for analysis without rewriting the authored geometry', () => {
    const source = glb();
    const converted = normalizeStaticGlb(source, 'y-up', 'z-up');
    const header = new DataView(converted.buffer);
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(converted.subarray(20, 20 + header.getUint32(12, true))),
    );
    expect(parsed).toMatchObject({
      nodes: [
        { translation: [2, 3, 4], mesh: 0 },
        { children: [0], rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
      ],
      scenes: [{ nodes: [1] }],
      extensions: { EXT_test_preserved: { value: 123 } },
    });
    const position = new Vector3(2, 3, 4).applyQuaternion(new Quaternion(Math.SQRT1_2, 0, 0, Math.SQRT1_2));
    expect(position.x).toBeCloseTo(2);
    expect(position.y).toBeCloseTo(-4);
    expect(position.z).toBeCloseTo(3);
    expect(position.length()).toBeCloseTo(Math.sqrt(29));
    expect(converted.subarray(-12)).toEqual(source.subarray(-12));
    expect(normalizeStaticGlb(source, 'z-up', 'z-up')).toBe(source);
  });

  it('should reject incomplete previews before passing them to the viewer', () => {
    expect(() => normalizeStaticGlb(new Uint8Array([1, 2, 3]), 'z-up')).toThrow('valid GLB');
    expect(() => normalizeStaticGlb(glb().subarray(0, 24), 'y-up')).toThrow('valid GLB');
  });
});
