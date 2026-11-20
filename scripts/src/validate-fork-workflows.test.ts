/* oxlint-disable no-template-curly-in-string -- These fixtures contain literal GitHub Actions expressions. */
import { describe, expect, it } from 'vitest';
import { hasUpstreamRepositoryGuard, validateForkWorkflows } from '#validate-fork-workflows.js';

describe('fork workflow boundaries', () => {
  it('accepts an upstream-only job and keeps an original condition inside the guard', () => {
    expect(hasUpstreamRepositoryGuard("${{ github.repository == 'taucad/tau' }}")).toBe(true);
    expect(
      hasUpstreamRepositoryGuard(
        "${{ github.repository == 'taucad/tau' && (always() && (needs.build.result == 'success' || !cancelled())) }}",
      ),
    ).toBe(true);
    expect(hasUpstreamRepositoryGuard("${{ github.repository == 'taucad/tau' && (contains('it''s )', ')')) }}")).toBe(
      true,
    );
  });

  it('rejects conditions that can run outside the upstream repository', () => {
    for (const condition of [
      undefined,
      true,
      '${{ always() }}',
      "${{ github.repository == 'taucad/tau' || always() }}",
      "${{ github.repository == 'taucad/tau' && (false) || (true) }}",
      "${{ github.repository == 'taucad/tau' && () }}",
      "${{ github.repository == 'taucad/tau' && (contains('unclosed, ')')) }}",
      "${{ github.repository == 'taucad/tau' && (true) }}${{ true }}",
    ]) {
      expect(hasUpstreamRepositoryGuard(condition)).toBe(false);
    }
  });

  it('checks every new upstream job even when a step has its own restriction', () => {
    const result = validateForkWorkflows([
      {
        name: 'future-publish.yml',
        text: `jobs:
  guarded:
    if: \${{ github.repository == 'taucad/tau' }}
    runs-on: ubuntu-latest
  unguarded:
    runs-on: ubuntu-latest
    steps:
      - if: \${{ github.repository == 'taucad/tau' }}
        run: echo publish
`,
      },
      { name: 'gallery-checks.yml', text: 'jobs: {gallery: {runs-on: ubuntu-latest}}' },
    ]);
    expect(result.jobs).toBe(2);
    expect(result.violations).toEqual(['future-publish.yml (unguarded): missing canonical upstream repository guard']);
  });

  it('fails malformed or vacuous input instead of silently checking no jobs', () => {
    expect(validateForkWorkflows([{ name: 'broken.yml', text: 'jobs: [' }]).violations.length).toBeGreaterThan(0);
    expect(validateForkWorkflows([{ name: 'empty.yml', text: 'name: Empty' }]).violations).toContain(
      'No upstream workflow jobs were checked',
    );
  });
});
