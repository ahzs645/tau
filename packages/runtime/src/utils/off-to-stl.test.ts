import { describe, it, expect } from 'vitest';
import { convertOffToStl } from '#utils/off-to-stl.js';

const validOff = `OFF 3 1 0
0 0 0
1 0 0
0 1 0
3 0 1 2
`;

describe('convertOffToStl', () => {
  it('should convert valid OFF to ASCII STL', async () => {
    const result = await convertOffToStl(validOff, 'stl');
    const text = new TextDecoder().decode(result);

    expect(text).toContain('solid model');
    expect(text).toContain('facet normal');
    expect(text).toContain('endsolid model');
  });

  it('should convert valid OFF to binary STL', async () => {
    const result = await convertOffToStl(validOff, 'stl-binary');

    expect(result).toBeInstanceOf(Uint8Array);

    const view = new DataView(result.buffer);
    const triangleCount = view.getUint32(80, true);
    expect(triangleCount).toBe(1);
  });

  it('should reject invalid OFF content', async () => {
    await expect(convertOffToStl('not valid', 'stl')).rejects.toThrow('Invalid OFF file');
  });
});
