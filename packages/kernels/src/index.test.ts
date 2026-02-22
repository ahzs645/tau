import { test, expect } from 'vitest';
import { createDefaultConfig } from '#config.js';

test('createDefaultConfig returns expected structure', () => {
  const config = createDefaultConfig();
  expect(config).toHaveProperty('workerUrl');
  expect(config).toHaveProperty('kernelConfig');
  expect(config).toHaveProperty('middlewareConfig');
  expect(config).toHaveProperty('bundlerConfig');
});
