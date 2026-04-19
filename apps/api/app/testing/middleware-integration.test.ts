// @vitest-environment node
import process from 'node:process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { collectStreamChunks, collectFinalMessage } from '#testing/stream-consumer.js';
import {
  expectNoErrors,
  extractUsageData,
  extractContextCompactionData,
  expectHasTextContent,
} from '#testing/stream-assertions.js';
import { createTestApp } from '#testing/create-test-app.js';
import type { TestApp } from '#testing/create-test-app.js';

const modelId = process.env['TEST_MODEL_ID'] ?? 'anthropic-claude-sonnet-4.6';

// ENABLE when testing middleware integration with real API keys.
// Requires: MORPH_API_KEY, model provider API key.
describe.skip(`Middleware Integration: ${modelId}`, () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  }, 30_000);

  afterAll(async () => {
    await testApp.app.close();
  });

  // ===========================================================================
  // Transcript middleware
  // ===========================================================================

  it('should write JSONL transcript to .tau/transcripts/', async () => {
    const threadId = `test-transcript-${Date.now()}`;

    const response = await fetch(`${testApp.baseUrl}/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: threadId,
        messages: [
          {
            id: 'msg_1',
            role: 'user',
            parts: [{ type: 'text', text: 'Say hello in exactly 5 words.' }],
            metadata: { model: modelId, kernel: 'replicad' },
          },
        ],
      }),
    });

    expect(response.ok, `HTTP ${response.status}: ${response.statusText}`).toBe(true);

    const chunks = await collectStreamChunks(response);
    expectNoErrors(chunks);

    const message = await collectFinalMessage(chunks);
    expectHasTextContent(message);

    const transcriptPath = `.tau/transcripts/${threadId}.jsonl`;
    const transcriptExists = await testApp.memFs.exists(transcriptPath);
    expect(transcriptExists, `Expected transcript file at ${transcriptPath}`).toBe(true);

    if (transcriptExists) {
      const content = await testApp.memFs.readFile(transcriptPath);
      const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
      const lines = text.split('\n').filter((l: string) => l.trim().length > 0);
      expect(lines.length).toBeGreaterThan(0);

      for (const line of lines) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(parsed).toHaveProperty('type');
        expect(parsed).toHaveProperty('timestamp');
      }
    }
  }, 60_000);

  // ===========================================================================
  // Tool offloading middleware
  // ===========================================================================

  it('should offload large tool results to .tau/offloaded-tool-results/', async () => {
    const threadId = `test-offload-${Date.now()}`;

    const response = await fetch(`${testApp.baseUrl}/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: threadId,
        messages: [
          {
            id: 'msg_1',
            role: 'user',
            parts: [
              {
                type: 'text',
                text: 'Search the web for "TypeScript performance optimization best practices 2026" and give me a detailed summary.',
              },
            ],
            metadata: { model: modelId, kernel: 'replicad' },
          },
        ],
      }),
    });

    expect(response.ok, `HTTP ${response.status}: ${response.statusText}`).toBe(true);

    const chunks = await collectStreamChunks(response);
    expectNoErrors(chunks);

    const message = await collectFinalMessage(chunks);
    expectHasTextContent(message);

    const usageData = extractUsageData(chunks);
    expect(usageData.length).toBeGreaterThan(0);
  }, 120_000);

  // ===========================================================================
  // Context compaction middleware
  // ===========================================================================

  it('should emit data-context-compaction when context exceeds threshold', async () => {
    const threadId = `test-compaction-${Date.now()}`;

    const longContent = 'A'.repeat(100_000);
    const messages = [];

    for (let i = 0; i < 20; i++) {
      messages.push({
        id: `msg_user_${i}`,
        role: 'user',
        parts: [{ type: 'text', text: `Turn ${i}: ${longContent.slice(0, 5000)}` }],
        metadata: { model: modelId, kernel: 'replicad' },
      });
      messages.push({
        id: `msg_assistant_${i}`,
        role: 'assistant',
        parts: [{ type: 'text', text: `Response ${i}: ${longContent.slice(0, 5000)}` }],
        metadata: { model: modelId, kernel: 'replicad' },
      });
    }

    messages.push({
      id: 'msg_final',
      role: 'user',
      parts: [{ type: 'text', text: 'Summarize what we discussed.' }],
      metadata: { model: modelId, kernel: 'replicad' },
    });

    const response = await fetch(`${testApp.baseUrl}/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: threadId, messages }),
    });

    expect(response.ok, `HTTP ${response.status}: ${response.statusText}`).toBe(true);

    const chunks = await collectStreamChunks(response);
    expectNoErrors(chunks);

    const compactionData = extractContextCompactionData(chunks);

    if (compactionData.length > 0) {
      const first = compactionData[0]!;
      expect(first).toHaveProperty('tokensBeforeCompaction');
      expect(first).toHaveProperty('tokensAfterCompaction');
      expect(first).toHaveProperty('compressionRatio');
      expect(first).toHaveProperty('messagesEvicted');

      const transcriptPath = `.tau/transcripts/${threadId}.jsonl`;
      const transcriptExists = await testApp.memFs.exists(transcriptPath);
      expect(transcriptExists, `Expected transcript at ${transcriptPath}`).toBe(true);
    }
  }, 120_000);

  // ===========================================================================
  // Full pipeline: compaction + transcript + usage tracking
  // ===========================================================================

  it('should emit usage, transcript, and compaction data in a multi-turn conversation', async () => {
    const threadId = `test-pipeline-${Date.now()}`;

    const response = await fetch(`${testApp.baseUrl}/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: threadId,
        messages: [
          {
            id: 'msg_1',
            role: 'user',
            parts: [
              {
                type: 'text',
                text: 'Create a file called main.ts with a simple Replicad cube. Use the create_file tool.',
              },
            ],
            metadata: { model: modelId, kernel: 'replicad' },
          },
        ],
      }),
    });

    expect(response.ok, `HTTP ${response.status}: ${response.statusText}`).toBe(true);

    const chunks = await collectStreamChunks(response);
    expectNoErrors(chunks);

    const usageData = extractUsageData(chunks);
    expect(usageData.length, 'Expected usage data to be emitted').toBeGreaterThan(0);

    const transcriptPath = `.tau/transcripts/${threadId}.jsonl`;
    const transcriptExists = await testApp.memFs.exists(transcriptPath);
    expect(transcriptExists, `Expected transcript at ${transcriptPath}`).toBe(true);
  }, 120_000);
});
