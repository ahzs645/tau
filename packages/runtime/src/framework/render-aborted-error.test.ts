/**
 * R19 — `RenderAbortedError.message` must reference the v6 command names
 * (`openFile` / `updateParameters`) instead of the legacy v5 command names
 * (`setFile` / `setParameters`).
 *
 * `RenderAbortedError` is internal cooperative-abort plumbing — it never
 * reaches the public client surface — but the message string is the only
 * trace surface a runtime-author sees in logs / debugger output, so it
 * must speak the same language as the public RuntimeClient API.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import { RenderAbortedError } from '#framework/runtime-worker-client.js';

describe('RenderAbortedError message (R19)', () => {
  it('references the v6 command names (openFile / updateParameters)', () => {
    const error = new RenderAbortedError();
    expect(error.message).toMatch(/openFile/);
    expect(error.message).toMatch(/updateParameters/);
  });

  it('does not reference the legacy v5 command names (setFile / setParameters)', () => {
    const error = new RenderAbortedError();
    expect(error.message).not.toMatch(/\bsetFile\b/);
    expect(error.message).not.toMatch(/\bsetParameters\b/);
  });
});
