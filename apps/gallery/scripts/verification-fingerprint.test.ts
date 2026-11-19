import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { verificationFingerprint } from '#scripts/verification-fingerprint.js';

it('should refuse stale resume evidence when source bytes or verification options change', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gallery-verification-'));
  try {
    await mkdir(path.join(root, 'sources'));
    await writeFile(path.join(root, 'sources/model.stl'), new Uint8Array([0, 0xff, 0x80, 7]));
    await writeFile(path.join(root, 'dependencies.yaml'), 'engine: 1');
    const input = { root, directories: ['sources'], files: ['dependencies.yaml'], options: { allExports: true } };
    const initial = await verificationFingerprint(input);
    expect(await verificationFingerprint(input)).toBe(initial);
    expect(await verificationFingerprint({ ...input, options: { allExports: false } })).not.toBe(initial);
    await writeFile(path.join(root, 'sources/model.stl'), new Uint8Array([0, 0xff, 0x81, 7]));
    expect(await verificationFingerprint(input)).not.toBe(initial);
    await writeFile(path.join(root, 'sources/model.stl'), new Uint8Array([0, 0xff, 0x80, 7]));
    await writeFile(path.join(root, 'dependencies.yaml'), 'engine: 2');
    expect(await verificationFingerprint(input)).not.toBe(initial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
