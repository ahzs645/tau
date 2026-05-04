/* eslint-disable @typescript-eslint/naming-convention -- langchain naming */
/**
 * Regression: @ai-sdk/langchain `case 'values'` historically re-emitted reasoning
 * blocks from prior-turn AIMessages stored in LangGraph state (`response_metadata.output`),
 * producing extra `reasoning-start` chunks attached to the following assistant message
 * (GPT-5 / OpenAI Responses API). Also guards empty `summary_text` deltas that would
 * materialise as empty “Thinking…” UI parts. See `pnpm patch @ai-sdk/langchain@2.0.147`.
 *
 * Uses a minimal fake LangGraph iterable (no network) that reproduces messages + values
 * sequencing from `graph.stream(..., { streamMode: ['messages', 'values'] })`.
 */
import { describe, expect, it } from 'vitest';
import { AIMessage, AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import { toUIMessageStream } from '@ai-sdk/langchain';
import type { UIMessageChunk } from 'ai';

const langgraphStepMeta = { langgraph_step: 0 };

/**
 * Simulates turn 2: model streams current assistant (`lc_current`), then a `values`
 * event replays full `messages` including a prior assistant checkpoint with OpenAI-style
 * reasoning in `response_metadata.output` (no tool calls).
 */
/** LangGraph `graph.stream(..., { streamMode: ['messages', 'values'] })` iterable (tuple yields). */
async function* fakeSecondTurnLangGraphStream(): AsyncIterable<readonly unknown[]> {
  const reasoningChunk = new AIMessageChunk({
    id: 'lc_current',
    content: '',
    additional_kwargs: {
      reasoning: {
        id: 'rs_current_turn',
        type: 'reasoning',
        summary: [{ text: 'Current turn reasoning delta.', index: 0 }],
      },
    },
  });
  yield ['messages', [reasoningChunk, langgraphStepMeta]];

  const textChunk = new AIMessageChunk({
    id: 'lc_current',
    content: [{ type: 'text', text: 'Final answer text.' }],
  });
  yield ['messages', [textChunk, langgraphStepMeta]];

  const priorTurnAssistant = new AIMessage({
    id: 'lc_prior_checkpoint',
    content: 'Prior turn user-visible answer.',
    response_metadata: {
      output: [
        {
          id: 'rs_prior_checkpoint_only',
          type: 'reasoning',
          summary: [
            {
              text: 'Prior turn reasoning that must not be re-emitted on values.',
              type: 'summary_text',
              index: 0,
            },
          ],
        },
      ],
    },
  });

  const currentTurnFinal = new AIMessage({
    id: 'lc_current',
    content: [{ type: 'text', text: 'Final answer text.' }],
  });

  yield ['values', { messages: [priorTurnAssistant, currentTurnFinal] }];
}

/** Trailing AIMessage with reasoning + tool_calls but no preceding `messages` tuples (HITL checkpoint resume). */
async function* fakeHitlTrailingValuesWithoutMessagesStream(): AsyncIterable<readonly unknown[]> {
  const hitlTrailing = new AIMessage({
    id: 'lc_hitl_trailing',
    content: [{ type: 'text', text: 'Pausing for approval.' }],
    tool_calls: [
      {
        id: 'call_hitl_1',
        name: 'noop',
        args: {},
        type: 'tool_call',
      },
    ],
    response_metadata: {
      output: [
        {
          id: 'rs_hitl_checkpoint',
          type: 'reasoning',
          summary: [
            {
              text: 'Checkpoint reasoning that must not synth-emit without streaming this HTTP request.',
              type: 'summary_text',
              index: 0,
            },
          ],
        },
      ],
    },
  });

  yield ['values', { messages: [hitlTrailing] }] as const;
}

/** Reasoning arrives only via `response_metadata.output` on the trailing AIMessage (no deltas streamed). */
async function* fakeValuesOnlySyntheticReasoningStream(): AsyncIterable<readonly unknown[]> {
  const userMessage = new HumanMessage({ id: 'user_turn', content: 'Hello' });
  const trailingAi = new AIMessage({
    id: 'lc_values_only_trailing',
    content: [{ type: 'text', text: 'Visible answer.' }],
    response_metadata: {
      output: [
        {
          id: 'rs_values_synthetic',
          type: 'reasoning',
          summary: [
            {
              text: 'Values-only-derived reasoning body.',
              type: 'summary_text',
              index: 0,
            },
          ],
        },
      ],
    },
  });

  yield ['values', { messages: [userMessage, trailingAi] }] as const;
}

/** OpenAI-style chunk with structural-only reasoning summary (`text: ''`) then visible text. */
async function* fakeEmptySummaryTextThenAnswerStream(): AsyncIterable<readonly unknown[]> {
  const emptySummaryChunk = new AIMessageChunk({
    id: 'lc_empty_summary',
    content: '',
    additional_kwargs: {
      reasoning: {
        id: 'rs_structural',
        type: 'reasoning',
        summary: [{ text: '', index: 0, type: 'summary_text' }],
      },
    },
  });
  yield ['messages', [emptySummaryChunk, langgraphStepMeta]];

  const textChunk = new AIMessageChunk({
    id: 'lc_empty_summary',
    content: [{ type: 'text', text: 'Answer only.' }],
  });
  yield ['messages', [textChunk, langgraphStepMeta]];
}

/** Empty summary delta then non-empty summary delta on the same assistant message id. */
async function* fakeEmptySummaryThenNonemptySummaryStream(): AsyncIterable<readonly unknown[]> {
  const emptyFirst = new AIMessageChunk({
    id: 'lc_mixed_summary',
    content: '',
    additional_kwargs: {
      reasoning: {
        id: 'rs_mixed',
        type: 'reasoning',
        summary: [{ text: '', index: 0 }],
      },
    },
  });
  yield ['messages', [emptyFirst, langgraphStepMeta]];

  const withBody = new AIMessageChunk({
    id: 'lc_mixed_summary',
    content: '',
    additional_kwargs: {
      reasoning: {
        id: 'rs_mixed',
        type: 'reasoning',
        summary: [{ text: 'Real reasoning content.', index: 0 }],
      },
    },
  });
  yield ['messages', [withBody, langgraphStepMeta]];

  const textChunk = new AIMessageChunk({
    id: 'lc_mixed_summary',
    content: [{ type: 'text', text: 'Visible answer.' }],
  });
  yield ['messages', [textChunk, langgraphStepMeta]];

  const finalizedAssistant = new AIMessage({
    id: 'lc_mixed_summary',
    content: [{ type: 'text', text: 'Visible answer.' }],
  });
  yield ['values', { messages: [finalizedAssistant] }] as const;
}

/** Reasoning deltas then assistant text on the same assistant message id — reasoning-end must precede text-start (not deferred to values). */
async function* fakeReasoningThenTextSameMessageIdStream(): AsyncIterable<readonly unknown[]> {
  const messageId = 'lc_transition_rt';
  yield [
    'messages',
    [
      new AIMessageChunk({
        id: messageId,
        content: '',
        additional_kwargs: {
          reasoning: {
            id: 'rs_rt',
            type: 'reasoning',
            summary: [{ text: 'Planning the edit.', index: 0 }],
          },
        },
      }),
      langgraphStepMeta,
    ],
  ];

  yield [
    'messages',
    [
      new AIMessageChunk({
        id: messageId,
        content: [{ type: 'text', text: 'Implementing change.' }],
      }),
      langgraphStepMeta,
    ],
  ];

  yield [
    'values',
    {
      messages: [
        new AIMessage({
          id: messageId,
          content: [{ type: 'text', text: 'Implementing change.' }],
        }),
      ],
    },
  ] as const;
}

/** Reasoning deltas then streaming tool_call_chunks on the same assistant message id — reasoning-end must precede tool-input-start. */
async function* fakeReasoningThenToolCallSameMessageIdStream(): AsyncIterable<readonly unknown[]> {
  const messageId = 'lc_transition_tool';
  yield [
    'messages',
    [
      new AIMessageChunk({
        id: messageId,
        content: '',
        additional_kwargs: {
          reasoning: {
            id: 'rs_tool',
            type: 'reasoning',
            summary: [{ text: 'Need to edit file.', index: 0 }],
          },
        },
      }),
      langgraphStepMeta,
    ],
  ];

  yield [
    'messages',
    [
      new AIMessageChunk({
        id: messageId,
        content: '',
        tool_call_chunks: [
          {
            index: 0,
            id: 'call_edit_rt',
            name: 'edit_file',
            args: '{"path":"/main.scad","content":"x"}',
          },
        ],
      }),
      langgraphStepMeta,
    ],
  ];

  yield [
    'values',
    {
      messages: [
        new AIMessage({
          id: messageId,
          content: '',
          tool_calls: [
            {
              id: 'call_edit_rt',
              name: 'edit_file',
              args: { path: '/main.scad', content: 'x' },
              type: 'tool_call',
            },
          ],
        }),
      ],
    },
  ] as const;
}

async function collectUiMessageChunks(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  const reader = stream.getReader();
  try {
    // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- read loop terminator
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- sequential ReadableStream drain
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      out.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return out;
}

describe('@ai-sdk/langchain values-mode historical reasoning leak', () => {
  it('emits only one reasoning-start for the live turn (prior checkpoint not re-emitted)', async () => {
    // `toUIMessageStream`'s public types list only `AIMessageChunk`, but accepts LangGraph tuple streams at runtime.
    const chunks = await collectUiMessageChunks(
      toUIMessageStream(fakeSecondTurnLangGraphStream() as AsyncIterable<AIMessageChunk>),
    );

    const reasoningStarts = chunks.filter(
      (chunk): chunk is UIMessageChunk & { type: 'reasoning-start' } => chunk.type === 'reasoning-start',
    );

    expect(reasoningStarts).toHaveLength(1);

    const leakedPrior = reasoningStarts.some((chunk) => chunk.id === 'lc_prior_checkpoint');
    expect(leakedPrior, 'Historical assistant id must not spawn its own reasoning-start').toBe(false);

    const currentOnly = reasoningStarts.every((chunk) => chunk.id === 'lc_current');
    expect(currentOnly).toBe(true);
  });

  it('does not synth-emit reasoning for HITL trailing AIMessage when tool_calls exist and messages were never streamed', async () => {
    const chunks = await collectUiMessageChunks(
      toUIMessageStream(fakeHitlTrailingValuesWithoutMessagesStream() as AsyncIterable<AIMessageChunk>),
    );

    expect(
      chunks.filter((chunk) => chunk.type === 'reasoning-start'),
      'Historical HITL assistant must stay silent until messages stream attaches',
    ).toHaveLength(0);
  });

  it('synth-emits reasoning triplet once for trailing AIMessage with values-only reasoning and no tool calls', async () => {
    const chunks = await collectUiMessageChunks(
      toUIMessageStream(fakeValuesOnlySyntheticReasoningStream() as AsyncIterable<AIMessageChunk>),
    );

    const reasoningStarts = chunks.filter(
      (chunk): chunk is UIMessageChunk & { type: 'reasoning-start' } => chunk.type === 'reasoning-start',
    );
    const deltas = chunks.filter(
      (chunk): chunk is UIMessageChunk & { type: 'reasoning-delta' } => chunk.type === 'reasoning-delta',
    );
    const reasoningEnds = chunks.filter(
      (chunk): chunk is UIMessageChunk & { type: 'reasoning-end' } => chunk.type === 'reasoning-end',
    );

    expect(reasoningStarts).toHaveLength(1);
    expect(reasoningEnds).toHaveLength(1);

    expect(reasoningStarts[0]?.id).toBe('lc_values_only_trailing');
    expect(deltas.at(-1)?.id).toBe('lc_values_only_trailing');

    expect(deltas.map((chunk) => chunk.delta).join('')).toBe('Values-only-derived reasoning body.');
  });

  it('does not emit reasoning-start for streaming chunks with empty summary text', async () => {
    const chunks = await collectUiMessageChunks(
      toUIMessageStream(fakeEmptySummaryTextThenAnswerStream() as AsyncIterable<AIMessageChunk>),
    );

    expect(chunks.filter((chunk) => chunk.type === 'reasoning-start')).toHaveLength(0);
    expect(
      chunks.filter(
        (chunk): chunk is UIMessageChunk & { type: 'reasoning-delta' } =>
          chunk.type === 'reasoning-delta' && chunk.delta === '',
      ),
    ).toHaveLength(0);
  });

  it('emits a single reasoning triplet when an empty chunk precedes a non-empty chunk', async () => {
    const chunks = await collectUiMessageChunks(
      toUIMessageStream(fakeEmptySummaryThenNonemptySummaryStream() as AsyncIterable<AIMessageChunk>),
    );

    const reasoningStarts = chunks.filter(
      (chunk): chunk is UIMessageChunk & { type: 'reasoning-start' } => chunk.type === 'reasoning-start',
    );
    const deltas = chunks.filter(
      (chunk): chunk is UIMessageChunk & { type: 'reasoning-delta' } => chunk.type === 'reasoning-delta',
    );
    const reasoningEnds = chunks.filter(
      (chunk): chunk is UIMessageChunk & { type: 'reasoning-end' } => chunk.type === 'reasoning-end',
    );

    expect(reasoningStarts).toHaveLength(1);
    expect(reasoningEnds).toHaveLength(1);
    expect(deltas.map((chunk) => chunk.delta).join('')).toBe('Real reasoning content.');
    expect(reasoningStarts[0]?.id).toBe('lc_mixed_summary');
  });

  it('emits reasoning-end before text-start on text transition (no duplicate reasoning-end from values)', async () => {
    const chunks = await collectUiMessageChunks(
      toUIMessageStream(fakeReasoningThenTextSameMessageIdStream() as AsyncIterable<AIMessageChunk>),
    );

    const types = chunks.map((chunk) => chunk.type);
    const reasoningStartIndex = types.indexOf('reasoning-start');
    const reasoningEndIndex = types.indexOf('reasoning-end');
    const textStartIndex = types.indexOf('text-start');

    expect(reasoningStartIndex).toBeGreaterThanOrEqual(0);
    expect(reasoningEndIndex).toBeGreaterThan(reasoningStartIndex);
    expect(textStartIndex).toBeGreaterThan(reasoningEndIndex);
    expect(types.filter((type) => type === 'reasoning-end')).toHaveLength(1);
  });

  it('emits reasoning-end before tool-input-start on tool-call transition', async () => {
    const chunks = await collectUiMessageChunks(
      toUIMessageStream(fakeReasoningThenToolCallSameMessageIdStream() as AsyncIterable<AIMessageChunk>),
    );

    const types = chunks.map((chunk) => chunk.type);
    const reasoningStartIndex = types.indexOf('reasoning-start');
    const reasoningEndIndex = types.indexOf('reasoning-end');
    const toolInputStartIndex = types.indexOf('tool-input-start');

    expect(reasoningStartIndex).toBeGreaterThanOrEqual(0);
    expect(reasoningEndIndex).toBeGreaterThan(reasoningStartIndex);
    expect(toolInputStartIndex).toBeGreaterThan(reasoningEndIndex);
    expect(types.filter((type) => type === 'reasoning-end')).toHaveLength(1);
  });
});
