/* Fixture: test files may import runtime testing helpers. */

import { getTestFileSystem } from '@taucad/runtime/testing';
import { expect, test } from 'vitest';

test('fixture', () => {
  expect(typeof getTestFileSystem).toBe('function');
});
