// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { packageName, packageVersion } from '#utils/package-info.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(currentDirectory, '../../package.json');
const onDisk = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
  name: string;
  version: string;
};

describe('package-info', () => {
  it('exposes packageName matching the on-disk package.json', () => {
    expect(packageName).toBe(onDisk.name);
    expect(packageName).toBe('@taucad/runtime');
  });

  it('exposes packageVersion matching the on-disk package.json', () => {
    expect(packageVersion).toBe(onDisk.version);
  });

  it('packageVersion is a non-empty semver-shaped string', () => {
    expect(typeof packageVersion).toBe('string');
    expect(packageVersion.length).toBeGreaterThan(0);
    expect(packageVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});
