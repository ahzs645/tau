import { expect, it } from 'vitest';
import { canReuseVariant } from '#scripts/verification-progress.js';

it('should keep completed failures visible while advancing a resumed batch', () => {
  const cases = [{ project: 'rack', variant: 'openscad', error: 'Strict export failure' }];
  const input = {
    project: 'rack',
    variant: 'openscad',
    finishedVariants: ['rack/openscad'],
    cases,
    retryFailures: false,
  };
  expect(canReuseVariant(input)).toBe(true);
  expect(cases[0]?.error).toBe('Strict export failure');
  expect(canReuseVariant({ ...input, retryFailures: true })).toBe(false);
});

it('should not reuse an interrupted variant or a completion marker without case evidence', () => {
  const input = {
    project: 'rack',
    variant: 'openscad',
    finishedVariants: [],
    cases: [{ project: 'rack', variant: 'openscad' }],
    retryFailures: false,
  };
  expect(canReuseVariant(input)).toBe(false);
  expect(canReuseVariant({ ...input, finishedVariants: ['rack/openscad'], cases: [] })).toBe(false);
  expect(canReuseVariant({ ...input, finishedVariants: ['rack/openscad'], retryFailures: true })).toBe(true);
});
