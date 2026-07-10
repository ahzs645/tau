// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(fileURLToPath(new URL('file-manager.worker.ts', import.meta.url)), 'utf8');

describe('file-manager.worker declaration boundary', () => {
  it('does not embed kernel declarations in the filesystem startup path', () => {
    expect(workerSource).not.toContain('@taucad/api-extractor');
    expect(workerSource).not.toContain('kernelTypeMaps');
    expect(workerSource).not.toContain('populateBundledTypesMount');
  });

  it('does not reference KCL markdown assets directly', () => {
    expect(workerSource).not.toContain('kcl-stdlib-compact.md');
    expect(workerSource).not.toContain('@taucad/api-extractor/kcl-reference');
  });
});
