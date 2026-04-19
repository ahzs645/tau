import { test, expect } from 'vitest';
import { presets } from '#plugins/presets.js';

test('presets.all() returns expected structure', () => {
  const config = presets.all();
  expect(config).toHaveProperty('kernels');
  expect(config).toHaveProperty('middleware');
  expect(config).toHaveProperty('bundlers');
});
