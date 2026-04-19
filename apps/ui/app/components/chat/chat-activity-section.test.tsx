import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ChatActivitySection } from '#components/chat/chat-activity-section.js';
import { ChatActivityGroup } from '#components/chat/chat-activity-group.js';

describe('ChatActivitySection', () => {
  it('should render the two-tone verb + detail label', () => {
    render(
      <ChatActivitySection summaryVerb='Explored' summaryDetail='12 searches, 2 fetches'>
        <div>activity content</div>
      </ChatActivitySection>,
    );

    const verbSpan = screen.getByText('Explored');
    const detailSpan = screen.getByText('12 searches, 2 fetches');

    expect(verbSpan).toHaveClass('text-foreground/60');
    expect(verbSpan).toHaveClass('font-medium');
    expect(detailSpan).toHaveClass('text-foreground/50');
  });

  it('should render only the verb when detail is empty (e.g. fallback "Activity")', () => {
    render(
      <ChatActivitySection summaryVerb='Activity' summaryDetail=''>
        <div>content</div>
      </ChatActivitySection>,
    );

    const verbSpan = screen.getByText('Activity');
    expect(verbSpan).toHaveClass('text-foreground/60');
    expect(verbSpan).toHaveClass('font-medium');
  });

  it('should default to expanded when no hasDownstreamText', () => {
    render(
      <ChatActivitySection summaryVerb='Activity' summaryDetail=''>
        <div data-testid='body'>content</div>
      </ChatActivitySection>,
    );

    expect(screen.getByTestId('body')).toBeInTheDocument();
  });

  it('should default to collapsed when hasDownstreamText is true', () => {
    render(
      <ChatActivitySection summaryVerb='Activity' summaryDetail='' hasDownstreamText>
        <div data-testid='body'>content</div>
      </ChatActivitySection>,
    );

    expect(screen.queryByTestId('body')).not.toBeInTheDocument();
  });

  it('should toggle when the trigger is clicked', async () => {
    render(
      <ChatActivitySection summaryVerb='Activity' summaryDetail='' hasDownstreamText>
        <div data-testid='body'>content</div>
      </ChatActivitySection>,
    );

    expect(screen.queryByTestId('body')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('body')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button'));
    expect(screen.queryByTestId('body')).not.toBeInTheDocument();
  });

  it('should set aria-expanded on the trigger button', async () => {
    render(
      <ChatActivitySection summaryVerb='Activity' summaryDetail='' hasDownstreamText>
        <div>content</div>
      </ChatActivitySection>,
    );

    const trigger = screen.getByRole('button');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('should respect user toggle even after initial collapse', async () => {
    render(
      <ChatActivitySection summaryVerb='Activity' summaryDetail='' hasDownstreamText>
        <div data-testid='body'>content</div>
      </ChatActivitySection>,
    );

    const trigger = screen.getByRole('button');
    await userEvent.click(trigger);
    expect(screen.getByTestId('body')).toBeInTheDocument();
  });

  it('should be open when isLast is true (no downstream text)', () => {
    render(
      <ChatActivitySection summaryVerb='Activity' summaryDetail='' isLast>
        <div data-testid='body'>content</div>
      </ChatActivitySection>,
    );

    expect(screen.getByTestId('body')).toBeInTheDocument();
  });

  it('should close when isLast transitions to false (downstream text arrives)', () => {
    const { rerender } = render(
      <ChatActivitySection summaryVerb='Activity' summaryDetail='' isLast>
        <div data-testid='body'>content</div>
      </ChatActivitySection>,
    );

    expect(screen.getByTestId('body')).toBeInTheDocument();

    rerender(
      <ChatActivitySection summaryVerb='Activity' summaryDetail='' isLast={false} hasDownstreamText>
        <div data-testid='body'>content</div>
      </ChatActivitySection>,
    );

    expect(screen.queryByTestId('body')).not.toBeInTheDocument();
  });

  it('should render a child ChatActivityGroup flat (no inner header) when nested inside the section', () => {
    render(
      <ChatActivitySection summaryVerb='Explored' summaryDetail='12 searches'>
        <ChatActivityGroup summaryVerb='Explored' summaryDetail='12 searches'>
          <div data-testid='inner-row'>tool row</div>
        </ChatActivityGroup>
      </ChatActivitySection>,
    );

    expect(screen.getByTestId('inner-row')).toBeInTheDocument();
    expect(screen.getAllByText('Explored')).toHaveLength(1);
    expect(screen.getAllByText('12 searches')).toHaveLength(1);
  });

  it('should respect user toggle over isLast', async () => {
    const { rerender } = render(
      <ChatActivitySection summaryVerb='Activity' summaryDetail='' isLast>
        <div data-testid='body'>content</div>
      </ChatActivitySection>,
    );

    expect(screen.getByTestId('body')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button'));
    expect(screen.queryByTestId('body')).not.toBeInTheDocument();

    rerender(
      <ChatActivitySection summaryVerb='Activity' summaryDetail='' isLast={false} hasDownstreamText>
        <div data-testid='body'>content</div>
      </ChatActivitySection>,
    );

    expect(screen.queryByTestId('body')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('body')).toBeInTheDocument();

    rerender(
      <ChatActivitySection summaryVerb='Activity' summaryDetail='' isLast={false} hasDownstreamText>
        <div data-testid='body'>content</div>
      </ChatActivitySection>,
    );

    expect(screen.getByTestId('body')).toBeInTheDocument();
  });
});
