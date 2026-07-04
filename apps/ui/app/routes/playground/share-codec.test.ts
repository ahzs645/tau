import { describe, expect, it } from 'vitest';
import { createPlaygroundShareCodec } from '#routes/playground/share-codec.js';

describe('playground share codec', () => {
  it('encodes parameter records as json-url compatible raw tokens', async () => {
    const codec = createPlaygroundShareCodec();

    const token = await codec.compress({ width: 99, style: 'hollow' });

    expect(token).toBe('1.raw.eyJ3aWR0aCI6OTksInN0eWxlIjoiaG9sbG93In0');
    await expect(codec.decompress(token)).resolves.toEqual({ width: 99, style: 'hollow' });
  });

  it('round-trips unicode values through base64url payloads', async () => {
    const codec = createPlaygroundShareCodec();

    const token = await codec.compress({ label: 'M4 x 12 mm', note: 'tolerance +/- 0.2' });

    expect(token).toMatch(/^1\.raw\.[\w-]+$/);
    await expect(codec.decompress(token)).resolves.toEqual({
      label: 'M4 x 12 mm',
      note: 'tolerance +/- 0.2',
    });
  });

  it('falls back instead of throwing for unsupported historical compressed tokens', async () => {
    const codec = createPlaygroundShareCodec();
    const fallback = { width: 42 };

    await expect(codec.tryDecompress('1.df.q1Yqz0wpyVCyMjHSUUpJLQAxDc1rAQ', fallback)).resolves.toBe(fallback);
  });
});
