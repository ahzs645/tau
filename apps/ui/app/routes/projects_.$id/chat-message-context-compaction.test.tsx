import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ContextCompactionData } from '@taucad/chat';
import { ChatMessageContextCompaction } from '#routes/projects_.$id/chat-message-context-compaction.js';

const createCompactionData = (overrides?: Partial<ContextCompactionData>): ContextCompactionData => ({
  type: 'context-compaction',
  id: 'dat_test',
  tokensBeforeCompaction: 50_000,
  tokensAfterCompaction: 5000,
  compressionRatio: 0.1,
  messagesEvicted: 15,
  transcriptFilePath: '.tau/transcripts/chat-1.jsonl',
  ...overrides,
});

describe('ChatMessageContextCompaction', () => {
  it('should render "Chat context summarized." text', () => {
    render(<ChatMessageContextCompaction data={createCompactionData()} />);

    expect(screen.getByText('Chat context summarized.')).toBeInTheDocument();
  });

  it('should show compression details on hover', async () => {
    render(<ChatMessageContextCompaction data={createCompactionData()} />);

    const badge = screen.getByText('Chat context summarized.');
    await userEvent.hover(badge);

    expect(await screen.findByText('Context Compaction')).toBeInTheDocument();
    expect(screen.getByText(/90%/)).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
  });

  it('should show transcript file path when present', async () => {
    render(
      <ChatMessageContextCompaction
        data={createCompactionData({ transcriptFilePath: '.tau/transcripts/test.jsonl' })}
      />,
    );

    const badge = screen.getByText('Chat context summarized.');
    await userEvent.hover(badge);

    expect(await screen.findByText('.tau/transcripts/test.jsonl')).toBeInTheDocument();
  });

  it('should not show transcript file path when null', async () => {
    render(<ChatMessageContextCompaction data={createCompactionData({ transcriptFilePath: null })} />);

    const badge = screen.getByText('Chat context summarized.');
    await userEvent.hover(badge);

    await screen.findByText('Context Compaction');
    expect(screen.queryByText('Transcript')).not.toBeInTheDocument();
  });
});
