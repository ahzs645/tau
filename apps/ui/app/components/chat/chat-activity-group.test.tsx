import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ChatActivityGroup } from '#components/chat/chat-activity-group.js';
import { ActivityFoldContext } from '#components/chat/chat-activity-fold-context.js';

const foldDisabledValue = { disableInnerFold: true } as const;
const foldEnabledValue = { disableInnerFold: false } as const;

describe('ChatActivityGroup', () => {
  describe('isLast=true (latest streaming group)', () => {
    it('should render children inline with no header chrome', () => {
      render(
        <ChatActivityGroup summaryVerb='Explored' summaryDetail='5 files' isLast>
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      expect(screen.getByTestId('child')).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.queryByText('Explored')).not.toBeInTheDocument();
      expect(screen.queryByText('5 files')).not.toBeInTheDocument();
    });

    it('should expose a header when the user explicitly collapses the live group', async () => {
      const { rerender } = render(
        <ChatActivityGroup summaryVerb='Explored' summaryDetail='5 files' isLast>
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      // Live group: no chrome yet. Re-render with isLast=false to surface a header so we can grab it,
      // then toggle back. We can't toggle without a trigger, so instead simulate the override path
      // by first letting isLast be false (showing button), clicking to expand, then toggling to collapsed.
      rerender(
        <ChatActivityGroup summaryVerb='Explored' summaryDetail='5 files' isLast={false}>
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      const trigger = screen.getByRole('button');
      // Currently collapsed: expand then collapse to cement the user-collapse override
      await userEvent.click(trigger);
      await userEvent.click(trigger);

      rerender(
        <ChatActivityGroup summaryVerb='Explored' summaryDetail='5 files' isLast>
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      // User-collapse override surfaces the header even when isLast=true
      expect(screen.getByRole('button')).toBeInTheDocument();
      expect(screen.queryByTestId('child')).not.toBeInTheDocument();
    });
  });

  describe('isLast=false (closed older group)', () => {
    it('should render the collapsed header with two-tone verb + detail spans', () => {
      render(
        <ChatActivityGroup summaryVerb='Explored' summaryDetail='3 files, 1 search'>
          <div data-testid='child'>hidden</div>
        </ChatActivityGroup>,
      );

      const trigger = screen.getByRole('button');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('child')).not.toBeInTheDocument();

      const verbSpan = screen.getByText('Explored');
      const detailSpan = screen.getByText('3 files, 1 search');

      expect(verbSpan).toHaveClass('text-foreground/60');
      expect(verbSpan).toHaveClass('font-medium');
      expect(detailSpan).toHaveClass('text-foreground/50');
    });

    it('should expand on click and render children flat (no border-l, no pl-4)', async () => {
      render(
        <ChatActivityGroup summaryVerb='Explored' summaryDetail='3 files'>
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      await userEvent.click(screen.getByRole('button'));

      const child = screen.getByTestId('child');
      expect(child).toBeInTheDocument();

      const parent = child.parentElement!;
      expect(parent.className).not.toMatch(/border-l/);
      expect(parent.className).not.toMatch(/pl-4/);
    });

    it('should collapse again when clicked twice', async () => {
      render(
        <ChatActivityGroup summaryVerb='Explored' summaryDetail='2 files'>
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      const trigger = screen.getByRole('button');
      await userEvent.click(trigger);
      expect(screen.getByTestId('child')).toBeInTheDocument();

      await userEvent.click(trigger);
      expect(screen.queryByTestId('child')).not.toBeInTheDocument();
    });
  });

  describe('inside ActivityFoldContext (disableInnerFold)', () => {
    it('should render children directly with no button, no chevron, no summary text', () => {
      render(
        <ActivityFoldContext.Provider value={foldDisabledValue}>
          <ChatActivityGroup summaryVerb='Explored' summaryDetail='12 searches'>
            <div data-testid='child'>row marker</div>
          </ChatActivityGroup>
        </ActivityFoldContext.Provider>,
      );

      expect(screen.getByTestId('child')).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.queryByText('Explored')).not.toBeInTheDocument();
      expect(screen.queryByText('12 searches')).not.toBeInTheDocument();
    });

    it('should render flat regardless of isLast=true', () => {
      render(
        <ActivityFoldContext.Provider value={foldDisabledValue}>
          <ChatActivityGroup summaryVerb='Explored' summaryDetail='12 searches' isLast>
            <div data-testid='child'>row marker</div>
          </ChatActivityGroup>
        </ActivityFoldContext.Provider>,
      );

      expect(screen.getByTestId('child')).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('should render flat regardless of isLast=false', () => {
      render(
        <ActivityFoldContext.Provider value={foldDisabledValue}>
          <ChatActivityGroup summaryVerb='Explored' summaryDetail='12 searches' isLast={false}>
            <div data-testid='child'>row marker</div>
          </ChatActivityGroup>
        </ActivityFoldContext.Provider>,
      );

      expect(screen.getByTestId('child')).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.queryByText('Explored')).not.toBeInTheDocument();
    });

    it('should still render its own chrome when disableInnerFold is explicitly false', () => {
      render(
        <ActivityFoldContext.Provider value={foldEnabledValue}>
          <ChatActivityGroup summaryVerb='Explored' summaryDetail='12 searches' isLast={false}>
            <div data-testid='child'>row marker</div>
          </ChatActivityGroup>
        </ActivityFoldContext.Provider>,
      );

      expect(screen.getByRole('button')).toBeInTheDocument();
      expect(screen.getByText('Explored')).toBeInTheDocument();
    });
  });

  describe('user toggle override across isLast transitions', () => {
    it('should keep an expanded older group open after isLast flips back to true', async () => {
      const { rerender } = render(
        <ChatActivityGroup summaryVerb='Explored' summaryDetail='2 files'>
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      await userEvent.click(screen.getByRole('button'));
      expect(screen.getByTestId('child')).toBeInTheDocument();

      rerender(
        <ChatActivityGroup summaryVerb='Explored' summaryDetail='2 files' isLast>
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      // With isLast=true and no user collapse, group renders inline (no button)
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.getByTestId('child')).toBeInTheDocument();
    });
  });
});
