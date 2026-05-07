/* eslint-disable @typescript-eslint/naming-convention -- LangChain message API uses snake_case */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { AttributeKey, GenAiInterruptRecoveryOutcome } from '@taucad/telemetry';
import { MetricsService } from '#telemetry/metrics.js';
import type { ModelService } from '#api/models/model.service.js';
import {
  createInterruptRecoveryMiddleware,
  detectInterruptedTurn,
  interruptRecoveryReminder,
  userInterruptedErrorCode,
} from '#api/chat/middleware/interrupt-recovery.middleware.js';
import type { InterruptRecoveryState } from '#api/chat/middleware/interrupt-recovery.middleware.js';
import { resolveMiddlewareHook } from '#testing/middleware-testing.utils.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

type BeforeModelState = InterruptRecoveryState & { messages: BaseMessage[] };
type BeforeModelRuntime = { context: { modelId?: string; modelService?: ModelService } };

const aiCallMessage = (input: {
  id?: string;
  calls: Array<{ name: string; args: Record<string, unknown>; id: string }>;
}): AIMessage =>
  new AIMessage({
    id: input.id,
    content: '',
    tool_calls: input.calls.map((call) => ({ name: call.name, args: call.args, id: call.id })),
  });

const successToolMessage = (input: { toolCallId: string; toolName: string; payload?: unknown }): ToolMessage =>
  new ToolMessage({
    content: typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload ?? { ok: true }),
    tool_call_id: input.toolCallId,
    name: input.toolName,
  });

const interruptedToolMessage = (input: { toolCallId: string; toolName: string }): ToolMessage =>
  new ToolMessage({
    content: JSON.stringify({
      errorCode: userInterruptedErrorCode,
      message: 'Interrupted by user.',
      toolCallId: input.toolCallId,
    }),
    tool_call_id: input.toolCallId,
    name: input.toolName,
    status: 'error',
  });

const otherErrorToolMessage = (input: {
  toolCallId: string;
  toolName: string;
  errorCode: string;
  message?: string;
}): ToolMessage =>
  new ToolMessage({
    content: JSON.stringify({
      errorCode: input.errorCode,
      message: input.message ?? 'failure',
      toolCallId: input.toolCallId,
    }),
    tool_call_id: input.toolCallId,
    name: input.toolName,
    status: 'error',
  });

const baseState = (overrides: Partial<InterruptRecoveryState> = {}): InterruptRecoveryState => ({
  _interruptReminderFiredFor: [],
  ...overrides,
});

const callBeforeModel = (
  middleware: ReturnType<typeof createInterruptRecoveryMiddleware>,
  state: BeforeModelState,
  runtime: BeforeModelRuntime,
): unknown => {
  const beforeModel = resolveMiddlewareHook(middleware.beforeModel);
  return beforeModel(state, runtime) as unknown;
};

// ---------------------------------------------------------------------------
// Pure detection (T1.1 — T1.4, T1.7, T1.8)
// ---------------------------------------------------------------------------

describe('detectInterruptedTurn', () => {
  it('T1.1 — returns clear when no ToolMessages are interrupted', () => {
    const messages: BaseMessage[] = [
      new HumanMessage('do the thing'),
      aiCallMessage({ id: 'ai_1', calls: [{ name: 'read_file', args: { path: 'a' }, id: 'tc_a' }] }),
      successToolMessage({ toolCallId: 'tc_a', toolName: 'read_file' }),
    ];

    expect(detectInterruptedTurn(messages)).toEqual({ kind: 'clear' });
  });

  it('T1.2 — counts a single interrupted tool with completed=0 / interrupted=1', () => {
    const messages: BaseMessage[] = [
      new HumanMessage('please write things'),
      aiCallMessage({
        id: 'ai_single',
        calls: [{ name: 'create_file', args: { targetFile: 'x.scad' }, id: 'tc_x' }],
      }),
      interruptedToolMessage({ toolCallId: 'tc_x', toolName: 'create_file' }),
    ];

    const result = detectInterruptedTurn(messages);
    expect(result.kind).toBe('detected');
    if (result.kind === 'detected') {
      expect(result.completedCount).toBe(0);
      expect(result.interruptedCount).toBe(1);
      expect(result.signature).toMatch(/^[\da-f]{16}$/);
    }
  });

  it('T1.3 — mixed tail (2 successful + 1 interrupted) reports counts 2/1', () => {
    const messages: BaseMessage[] = [
      new HumanMessage('do it'),
      aiCallMessage({
        id: 'ai_mixed',
        calls: [
          { name: 'read_file', args: { path: 'a' }, id: 'tc_a' },
          { name: 'read_file', args: { path: 'b' }, id: 'tc_b' },
          { name: 'create_file', args: { targetFile: 'x.scad' }, id: 'tc_x' },
        ],
      }),
      successToolMessage({ toolCallId: 'tc_a', toolName: 'read_file' }),
      successToolMessage({ toolCallId: 'tc_b', toolName: 'read_file' }),
      interruptedToolMessage({ toolCallId: 'tc_x', toolName: 'create_file' }),
    ];

    const result = detectInterruptedTurn(messages);
    expect(result.kind).toBe('detected');
    if (result.kind === 'detected') {
      expect(result.completedCount).toBe(2);
      expect(result.interruptedCount).toBe(1);
    }
  });

  it('T1.4 — all-N-interrupted reports counts 0/N', () => {
    const messages: BaseMessage[] = [
      new HumanMessage('do everything'),
      aiCallMessage({
        id: 'ai_all',
        calls: [
          { name: 'create_file', args: { targetFile: 'a' }, id: 'tc_1' },
          { name: 'edit_file', args: { targetFile: 'b' }, id: 'tc_2' },
          { name: 'delete_file', args: { targetFile: 'c' }, id: 'tc_3' },
        ],
      }),
      interruptedToolMessage({ toolCallId: 'tc_1', toolName: 'create_file' }),
      interruptedToolMessage({ toolCallId: 'tc_2', toolName: 'edit_file' }),
      interruptedToolMessage({ toolCallId: 'tc_3', toolName: 'delete_file' }),
    ];

    const result = detectInterruptedTurn(messages);
    expect(result.kind).toBe('detected');
    if (result.kind === 'detected') {
      expect(result.completedCount).toBe(0);
      expect(result.interruptedCount).toBe(3);
    }
  });

  it('T1.7 — different parent AIMessage ids produce different signatures (re-fire path)', () => {
    const buildTail = (id: string, callId: string): BaseMessage[] => [
      new HumanMessage('do it'),
      aiCallMessage({ id, calls: [{ name: 'create_file', args: { targetFile: 'x' }, id: callId }] }),
      interruptedToolMessage({ toolCallId: callId, toolName: 'create_file' }),
    ];

    const detectionA = detectInterruptedTurn(buildTail('ai_aaa', 'tc_aaa'));
    const detectionB = detectInterruptedTurn(buildTail('ai_bbb', 'tc_bbb'));

    expect(detectionA.kind).toBe('detected');
    expect(detectionB.kind).toBe('detected');
    if (detectionA.kind === 'detected' && detectionB.kind === 'detected') {
      expect(detectionA.signature).not.toBe(detectionB.signature);
    }
  });

  it('T1.8 — non-USER_INTERRUPTED errorCode (e.g. IO_ERROR) does not trip the detector', () => {
    const messages: BaseMessage[] = [
      new HumanMessage('do the thing'),
      aiCallMessage({
        id: 'ai_io',
        calls: [{ name: 'create_file', args: { targetFile: 'x' }, id: 'tc_io' }],
      }),
      otherErrorToolMessage({ toolCallId: 'tc_io', toolName: 'create_file', errorCode: 'IO_ERROR' }),
    ];

    expect(detectInterruptedTurn(messages)).toEqual({ kind: 'clear' });
  });

  it('returns clear when a fresh user message terminates the trailing tool block', () => {
    // Defensive: a HumanMessage between the parent AIMessage and the inspection
    // window means the user has already moved on and the reminder is stale.
    const messages: BaseMessage[] = [
      new HumanMessage('do the thing'),
      aiCallMessage({ id: 'ai_x', calls: [{ name: 'create_file', args: { targetFile: 'x' }, id: 'tc_x' }] }),
      interruptedToolMessage({ toolCallId: 'tc_x', toolName: 'create_file' }),
      new HumanMessage('actually never mind, do something else'),
    ];

    expect(detectInterruptedTurn(messages)).toEqual({ kind: 'clear' });
  });

  it('returns clear when there is no parent AIMessage with tool_calls', () => {
    const messages: BaseMessage[] = [new HumanMessage('hello')];
    expect(detectInterruptedTurn(messages)).toEqual({ kind: 'clear' });
  });
});

// ---------------------------------------------------------------------------
// Cache-stable reminder body (T1.5)
// ---------------------------------------------------------------------------

describe('interruptRecoveryReminder', () => {
  it('T1.5 — produces byte-identical output for byte-identical inputs', () => {
    const a = interruptRecoveryReminder({ completedCount: 2, interruptedCount: 1 });
    const b = interruptRecoveryReminder({ completedCount: 2, interruptedCount: 1 });
    expect(a).toBe(b);
  });

  it('T1.5 — body has no timestamps, UUIDs, or run identifiers', () => {
    const body = interruptRecoveryReminder({ completedCount: 0, interruptedCount: 1 });
    // ISO 8601 dates / UUIDs / random hex would invalidate the prompt cache
    // prefix on every turn — assert their absence.
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(body).not.toMatch(/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}/);
  });

  it('T1.5 — embeds the literal completed/interrupted counts', () => {
    expect(interruptRecoveryReminder({ completedCount: 5, interruptedCount: 7 })).toContain(
      '5 tool call(s)\ncompleted successfully and 7 were cancelled',
    );
  });

  it('T1.5 — body advises verification before retrying', () => {
    const body = interruptRecoveryReminder({ completedCount: 1, interruptedCount: 2 });
    expect(body).toMatch(/verify the current state/);
    expect(body).toMatch(/Do NOT assume/);
  });
});

// ---------------------------------------------------------------------------
// Middleware contract: hook injection, dedup, telemetry (T1.6, T1.9)
// ---------------------------------------------------------------------------

describe('createInterruptRecoveryMiddleware', () => {
  let metricsService: MetricsService;
  let modelService: ReturnType<typeof mock<ModelService>>;

  beforeEach(() => {
    vi.clearAllMocks();
    metricsService = new MetricsService();
    vi.spyOn(metricsService.genAiInterruptRecoveryReminders, 'add');
    modelService = mock<ModelService>();
    modelService.getOtelProviderName.mockReturnValue('anthropic');
  });

  const interruptedTail: BaseMessage[] = [
    new HumanMessage('please write x'),
    aiCallMessage({ id: 'ai_canon', calls: [{ name: 'create_file', args: { targetFile: 'x' }, id: 'tc_canon' }] }),
    interruptedToolMessage({ toolCallId: 'tc_canon', toolName: 'create_file' }),
  ];

  it('exposes the beforeModel hook only', () => {
    const middleware = createInterruptRecoveryMiddleware(metricsService);
    expect(middleware.beforeModel).toBeDefined();
    expect(middleware.wrapModelCall).toBeUndefined();
  });

  it('appends a HumanMessage(<system-reminder>) when an interrupted tail is detected', () => {
    const middleware = createInterruptRecoveryMiddleware(metricsService);
    const state = { ...baseState(), messages: interruptedTail };

    const result = callBeforeModel(middleware, state, {
      context: { modelId: 'anthropic-claude-sonnet-4.6', modelService },
    }) as { messages: BaseMessage[]; _interruptReminderFiredFor: string[] };

    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages).toHaveLength(1);

    const reminder = result.messages[0];
    expect(reminder).toBeInstanceOf(HumanMessage);
    expect(typeof reminder?.content).toBe('string');
    expect(reminder?.content as string).toMatch(/^<system-reminder>\n[\S\s]+\n<\/system-reminder>$/);
    expect(reminder?.content as string).toContain('verify the current state');
    expect(result._interruptReminderFiredFor).toHaveLength(1);
  });

  it('returns no state update when no interrupted tail is detected', () => {
    const middleware = createInterruptRecoveryMiddleware(metricsService);
    const state = {
      ...baseState(),
      messages: [
        new HumanMessage('do the thing'),
        aiCallMessage({ id: 'ai_noop', calls: [{ name: 'read_file', args: { path: 'a' }, id: 'tc_noop' }] }),
        successToolMessage({ toolCallId: 'tc_noop', toolName: 'read_file' }),
      ],
    } satisfies BeforeModelState;

    const result = callBeforeModel(middleware, state, { context: {} });

    expect(result).toEqual({});
    expect(metricsService.genAiInterruptRecoveryReminders.add).not.toHaveBeenCalled();
  });

  it('T1.6 — re-firing on the same parent AIMessage signature is suppressed via state dedup', () => {
    const middleware = createInterruptRecoveryMiddleware(metricsService);
    const state = { ...baseState(), messages: interruptedTail };

    const first = callBeforeModel(middleware, state, { context: {} }) as {
      messages: BaseMessage[];
      _interruptReminderFiredFor: string[];
    };
    expect(first.messages).toHaveLength(1);

    const stateAfterFirst: BeforeModelState = {
      ...state,
      _interruptReminderFiredFor: first._interruptReminderFiredFor,
    };

    const second = callBeforeModel(middleware, stateAfterFirst, { context: {} });
    expect(second).toEqual({});
  });

  it('T1.9 — telemetry counter records "emitted" on first fire and "already_fired" on dedup-suppress', () => {
    const middleware = createInterruptRecoveryMiddleware(metricsService);
    const state = { ...baseState(), messages: interruptedTail };

    callBeforeModel(middleware, state, {
      context: { modelId: 'anthropic-claude-sonnet-4.6', modelService },
    });

    expect(metricsService.genAiInterruptRecoveryReminders.add).toHaveBeenNthCalledWith(
      1,
      1,
      expect.objectContaining({
        [AttributeKey.GEN_AI_INTERRUPT_RECOVERY_OUTCOME]: GenAiInterruptRecoveryOutcome.EMITTED,
        [AttributeKey.GEN_AI_REQUEST_MODEL]: 'anthropic-claude-sonnet-4.6',
        [AttributeKey.GEN_AI_PROVIDER_NAME]: 'anthropic',
      }),
    );

    const dedupState: BeforeModelState = {
      ...state,
      _interruptReminderFiredFor: [extractFiredSignature(state.messages)],
    };

    callBeforeModel(middleware, dedupState, {
      context: { modelId: 'anthropic-claude-sonnet-4.6', modelService },
    });

    expect(metricsService.genAiInterruptRecoveryReminders.add).toHaveBeenNthCalledWith(
      2,
      1,
      expect.objectContaining({
        [AttributeKey.GEN_AI_INTERRUPT_RECOVERY_OUTCOME]: GenAiInterruptRecoveryOutcome.ALREADY_FIRED,
        [AttributeKey.GEN_AI_REQUEST_MODEL]: 'anthropic-claude-sonnet-4.6',
        [AttributeKey.GEN_AI_PROVIDER_NAME]: 'anthropic',
      }),
    );
  });

  it('skips model/provider attributes when modelId/modelService are absent', () => {
    const middleware = createInterruptRecoveryMiddleware(metricsService);
    const state = { ...baseState(), messages: interruptedTail };

    callBeforeModel(middleware, state, { context: {} });

    expect(metricsService.genAiInterruptRecoveryReminders.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        [AttributeKey.GEN_AI_INTERRUPT_RECOVERY_OUTCOME]: GenAiInterruptRecoveryOutcome.EMITTED,
      }),
    );
    const callArgs = vi.mocked(metricsService.genAiInterruptRecoveryReminders.add).mock.calls[0]?.[1];
    expect(callArgs).toBeDefined();
    expect(callArgs).not.toHaveProperty(AttributeKey.GEN_AI_REQUEST_MODEL);
    expect(callArgs).not.toHaveProperty(AttributeKey.GEN_AI_PROVIDER_NAME);
  });

  it('appends to an existing _interruptReminderFiredFor array on a fresh parent', () => {
    // After a first interrupt has been recorded, a *new* interrupted turn
    // (different parent AIMessage id → different signature) must still fire and
    // accumulate the signature alongside the prior one.
    const middleware = createInterruptRecoveryMiddleware(metricsService);

    const messagesWithNewParent: BaseMessage[] = [
      new HumanMessage('do another thing'),
      aiCallMessage({
        id: 'ai_second_turn',
        calls: [{ name: 'edit_file', args: { targetFile: 'y' }, id: 'tc_second' }],
      }),
      interruptedToolMessage({ toolCallId: 'tc_second', toolName: 'edit_file' }),
    ];

    const state: BeforeModelState = {
      _interruptReminderFiredFor: ['previous-signature-aaaaaaaa'],
      messages: messagesWithNewParent,
    };

    const result = callBeforeModel(middleware, state, { context: {} }) as {
      messages: BaseMessage[];
      _interruptReminderFiredFor: string[];
    };

    expect(result.messages).toHaveLength(1);
    expect(result._interruptReminderFiredFor).toHaveLength(2);
    expect(result._interruptReminderFiredFor[0]).toBe('previous-signature-aaaaaaaa');
  });
});

// Helper: extract the signature the middleware would compute for a given
// message tail by running detectInterruptedTurn directly (so tests don't have
// to depend on the SHA-256 hex of a magic string).
function extractFiredSignature(messages: BaseMessage[]): string {
  const detection = detectInterruptedTurn(messages);
  if (detection.kind !== 'detected') {
    throw new Error('expected detected detection for fixture');
  }
  return detection.signature;
}
