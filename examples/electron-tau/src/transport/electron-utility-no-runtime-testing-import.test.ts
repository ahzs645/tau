/**
 * Guards the Electron Topology-C transport against re-introducing the
 * `getTestFileSystem` / `@taucad/runtime/testing` regression (vitest in
 * the renderer bundle — blank window in `electron-vite dev`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const transportSource = join(sourceDirectory, 'electron-utility-transport.ts');

describe('electronUtilityTransport source hygiene', () => {
  it('never imports `@taucad/runtime/testing`', () => {
    const text = readFileSync(transportSource, 'utf8');
    expect(text.includes('@taucad/runtime/testing')).toBe(false);
  });
});
