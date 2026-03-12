import { describe, it, expect } from 'vitest';
import UZIP from 'uzip';
import { convertOffTo3mf } from '#utils/off-to-3mf.js';

const validOff = `OFF 3 1 0
0 0 0
1 0 0
0 1 0
3 0 1 2
`;

describe('convertOffTo3mf', () => {
  it('should convert valid OFF to 3MF ZIP output', async () => {
    const result = await convertOffTo3mf(validOff);
    const parsed = UZIP.parse(result.buffer);

    expect(parsed['[Content_Types].xml']).toBeDefined();
    expect(parsed['3D/3dmodel.model']).toBeDefined();

    const modelXml = new TextDecoder().decode(parsed['3D/3dmodel.model']);
    expect(modelXml).toContain('<vertex');
    expect(modelXml).toContain('<triangle');
  });

  it('should pass extruder colors through to export3mf', async () => {
    const extruderColors: Array<[number, number, number]> = [
      [1, 0, 0],
      [0, 1, 0],
    ];

    const result = await convertOffTo3mf(validOff, extruderColors);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.byteLength).toBeGreaterThan(0);
  });

  it('should reject invalid OFF content', async () => {
    await expect(convertOffTo3mf('garbage input')).rejects.toThrow('Invalid OFF file');
  });
});
