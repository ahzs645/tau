import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp } from '#testing/create-test-app.js';
import type { TestApp } from '#testing/create-test-app.js';
import { collectStreamChunks } from '#testing/stream-consumer.js';
import { expectChunkTypesInclude, expectNoErrors } from '#testing/stream-assertions.js';

/**
 * Real-LLM checks for cross-provider thinking/reasoning portability (checkpoint replay).
 *
 * Un-skip locally with provider keys in `apps/api/.env` to confirm Anthropic thinking
 * history followed by Gemini/OpenAI turns succeeds end-to-end after middleware + V1 config.
 *
 * Always-on coverage lives in `cross-provider-content-normalizer.middleware.test.ts`.
 */
describe.skip('Cross-provider thinking-block portability (real LLM)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.app.close();
  });

  const buildThinkingThenAskPayload = (models: { first: string; second: string }) => ({
    id: `cross-provider-thinking-${models.first}-${models.second}-${Date.now()}`,
    messages: [
      {
        id: 'msg_user_1',
        role: 'user',
        parts: [{ type: 'text', text: 'Reply with a single word: hello.' }],
        metadata: { model: models.first, kernel: 'replicad' },
      },
      {
        id: 'msg_assistant_thinking',
        role: 'assistant',
        parts: [
          {
            type: 'reasoning',
            text: 'User wants one word.',
            providerMetadata: { anthropic: { thinkingSignature: 'dummy-signature-for-portability-test' } },
          },
          { type: 'text', text: 'hello', state: 'done' },
        ],
        metadata: { model: models.first, kernel: 'replicad' },
      },
      {
        id: 'msg_user_2',
        role: 'user',
        parts: [{ type: 'text', text: 'Now reply with a single word: bye.' }],
        metadata: { model: models.second, kernel: 'replicad' },
      },
    ],
  });

  it('accepts Anthropic-shaped thinking history then Gemini follow-up', async () => {
    const response = await fetch(`${testApp.baseUrl}/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        buildThinkingThenAskPayload({ first: 'anthropic-claude-haiku-4.5', second: 'google-gemini-3-flash' }),
      ),
    });

    expect(response.ok, `HTTP ${response.status}`).toBe(true);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const chunks = await collectStreamChunks(response);
    expectNoErrors(chunks);
    expectChunkTypesInclude(chunks, 'text-start');
  });

  it('accepts Anthropic-shaped thinking history then OpenAI follow-up', async () => {
    const response = await fetch(`${testApp.baseUrl}/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        buildThinkingThenAskPayload({ first: 'anthropic-claude-haiku-4.5', second: 'openai-gpt-5.3-codex' }),
      ),
    });

    expect(response.ok, `HTTP ${response.status}`).toBe(true);
    const chunks = await collectStreamChunks(response);
    expectNoErrors(chunks);
    expectChunkTypesInclude(chunks, 'text-start');
  });

  it('accepts Vertex Gemini history then Anthropic follow-up (signature stripped upstream)', async () => {
    const response = await fetch(`${testApp.baseUrl}/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        buildThinkingThenAskPayload({ first: 'google-gemini-3-flash', second: 'anthropic-claude-haiku-4.5' }),
      ),
    });

    expect(response.ok, `HTTP ${response.status}`).toBe(true);
    const chunks = await collectStreamChunks(response);
    expectNoErrors(chunks);
    expectChunkTypesInclude(chunks, 'text-start');
  });
});
