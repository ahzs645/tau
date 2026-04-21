import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ChatActivityGroup } from '#components/chat/chat-activity-group.js';
import { ActivityFoldContext } from '#components/chat/chat-activity-fold-context.js';

const foldDisabledValue = { disableInnerFold: true } as const;
const foldEnabledValue = { disableInnerFold: false } as const;

describe('ChatActivityGroup', () => {
  describe('isActive=true (latest streaming group)', () => {
    it('should render children inline with no header chrome', () => {
      render(
        <ChatActivityGroup summaryVerbPast='Explored' summaryVerbActive='Exploring' summaryDetail='5 files' isActive>
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      expect(screen.getByTestId('child')).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.queryByText('Explored')).not.toBeInTheDocument();
      expect(screen.queryByText('Exploring…')).not.toBeInTheDocument();
      expect(screen.queryByText('5 files')).not.toBeInTheDocument();
    });

    it('should expose a header when the user explicitly collapses the live group', async () => {
      const { rerender } = render(
        <ChatActivityGroup summaryVerbPast='Explored' summaryVerbActive='Exploring' summaryDetail='5 files' isActive>
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      // Live group: no chrome yet. Re-render with isActive=false to surface a header so we can grab it,
      // then toggle back. We can't toggle without a trigger, so instead simulate the override path
      // by first letting isActive be false (showing button), clicking to expand, then toggling to collapsed.
      rerender(
        <ChatActivityGroup
          summaryVerbPast='Explored'
          summaryVerbActive='Exploring'
          summaryDetail='5 files'
          isActive={false}
        >
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      const trigger = screen.getByRole('button');
      // Currently collapsed: expand then collapse to cement the user-collapse override
      await userEvent.click(trigger);
      await userEvent.click(trigger);

      rerender(
        <ChatActivityGroup summaryVerbPast='Explored' summaryVerbActive='Exploring' summaryDetail='5 files' isActive>
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      // User-collapse override surfaces the header even when isActive=true
      expect(screen.getByRole('button')).toBeInTheDocument();
      expect(screen.queryByTestId('child')).not.toBeInTheDocument();
    });

    it('should show present tense after the user collapses a live (isActive) group', async () => {
      const { rerender } = render(
        <ChatActivityGroup
          summaryVerbPast='Explored'
          summaryVerbActive='Exploring'
          summaryDetail='5 files'
          isActive={false}
        >
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      const trigger = screen.getByRole('button');
      // Expand then collapse to set the user-collapse override
      await userEvent.click(trigger);
      await userEvent.click(trigger);

      rerender(
        <ChatActivityGroup summaryVerbPast='Explored' summaryVerbActive='Exploring' summaryDetail='5 files' isActive>
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      // Header surfaces (user-collapsed override) and renders present tense because isActive=true
      expect(screen.getByRole('button')).toBeInTheDocument();
      expect(screen.getByText('Exploring…')).toBeInTheDocument();
      expect(screen.queryByText('Explored')).not.toBeInTheDocument();
    });

    it('should apply the shimmer animation to the active title (matches per-tool loading state)', async () => {
      const { rerender } = render(
        <ChatActivityGroup
          summaryVerbPast='Explored'
          summaryVerbActive='Exploring'
          summaryDetail='5 files'
          isActive={false}
        >
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      // Force the user-collapse override so a header surfaces while isActive=true
      const trigger = screen.getByRole('button');
      await userEvent.click(trigger);
      await userEvent.click(trigger);

      rerender(
        <ChatActivityGroup summaryVerbPast='Explored' summaryVerbActive='Exploring' summaryDetail='5 files' isActive>
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      const activeLabel = screen.getByText('Exploring…');
      expect(activeLabel).toHaveClass('animate-shiny-text');
    });
  });

  describe('isActive=false (closed older group)', () => {
    it('should render the collapsed header with two-tone verb + detail spans', () => {
      render(
        <ChatActivityGroup summaryVerbPast='Explored' summaryVerbActive='Exploring' summaryDetail='3 files, 1 search'>
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

    it('should declare the shared chat-tool trigger named group on the trigger button so labels lift on hover', () => {
      render(
        <ChatActivityGroup summaryVerbPast='Explored' summaryVerbActive='Exploring' summaryDetail='3 files, 1 search'>
          <div data-testid='child'>hidden</div>
        </ChatActivityGroup>,
      );

      const trigger = screen.getByRole('button');
      expect(trigger).toHaveClass('group/chat-tool-trigger');

      expect(screen.getByText('Explored')).toHaveClass('group-hover/chat-tool-trigger:text-foreground');
      expect(screen.getByText('3 files, 1 search')).toHaveClass('group-hover/chat-tool-trigger:text-foreground/80');
    });

    it('should keep past tense regardless of open/closed when isActive=false', async () => {
      render(
        <ChatActivityGroup summaryVerbPast='Explored' summaryVerbActive='Exploring' summaryDetail='3 files, 1 search'>
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      // Closed: past tense
      expect(screen.getByText('Explored')).toBeInTheDocument();
      expect(screen.getByText('3 files, 1 search')).toBeInTheDocument();
      expect(screen.queryByText('Exploring…')).not.toBeInTheDocument();

      // Expanded: still past tense — tense is driven by isActive, not open state
      await userEvent.click(screen.getByRole('button'));

      expect(screen.getByText('Explored')).toBeInTheDocument();
      expect(screen.getByText('3 files, 1 search')).toBeInTheDocument();
      expect(screen.queryByText('Exploring…')).not.toBeInTheDocument();
    });

    it('should not apply the shimmer animation to past-tense (concluded) titles', () => {
      render(
        <ChatActivityGroup summaryVerbPast='Explored' summaryVerbActive='Exploring' summaryDetail='3 files, 1 search'>
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      expect(screen.getByText('Explored')).not.toHaveClass('animate-shiny-text');
      expect(screen.getByText('3 files, 1 search')).not.toHaveClass('animate-shiny-text');
    });

    it('should render past-tense closed header on a trailing group whose stream has ended (isActive=false)', () => {
      render(
        <ChatActivityGroup summaryVerbPast='Explored' summaryVerbActive='Exploring' summaryDetail='1 file, 5 searches'>
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      // Cancel mid-stream / streaming-ended on the trailing group: header surfaces past-tense.
      expect(screen.getByRole('button')).toBeInTheDocument();
      expect(screen.getByText('Explored')).toBeInTheDocument();
      expect(screen.getByText('1 file, 5 searches')).toBeInTheDocument();
      expect(screen.queryByText('Exploring…')).not.toBeInTheDocument();
      expect(screen.queryByTestId('child')).not.toBeInTheDocument();
    });

    it('should expand on click and render children flat (no border-l, no pl-4)', async () => {
      render(
        <ChatActivityGroup summaryVerbPast='Explored' summaryVerbActive='Exploring' summaryDetail='3 files'>
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
        <ChatActivityGroup summaryVerbPast='Explored' summaryVerbActive='Exploring' summaryDetail='2 files'>
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
          <ChatActivityGroup summaryVerbPast='Explored' summaryVerbActive='Exploring' summaryDetail='12 searches'>
            <div data-testid='child'>row marker</div>
          </ChatActivityGroup>
        </ActivityFoldContext.Provider>,
      );

      expect(screen.getByTestId('child')).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.queryByText('Explored')).not.toBeInTheDocument();
      expect(screen.queryByText('Exploring…')).not.toBeInTheDocument();
      expect(screen.queryByText('12 searches')).not.toBeInTheDocument();
    });

    it('should render flat regardless of isActive=true', () => {
      render(
        <ActivityFoldContext.Provider value={foldDisabledValue}>
          <ChatActivityGroup
            summaryVerbPast='Explored'
            summaryVerbActive='Exploring'
            summaryDetail='12 searches'
            isActive
          >
            <div data-testid='child'>row marker</div>
          </ChatActivityGroup>
        </ActivityFoldContext.Provider>,
      );

      expect(screen.getByTestId('child')).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('should render flat regardless of isActive=false', () => {
      render(
        <ActivityFoldContext.Provider value={foldDisabledValue}>
          <ChatActivityGroup
            summaryVerbPast='Explored'
            summaryVerbActive='Exploring'
            summaryDetail='12 searches'
            isActive={false}
          >
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
          <ChatActivityGroup
            summaryVerbPast='Explored'
            summaryVerbActive='Exploring'
            summaryDetail='12 searches'
            isActive={false}
          >
            <div data-testid='child'>row marker</div>
          </ChatActivityGroup>
        </ActivityFoldContext.Provider>,
      );

      expect(screen.getByRole('button')).toBeInTheDocument();
      expect(screen.getByText('Explored')).toBeInTheDocument();
    });
  });

  describe('user toggle override across isActive transitions', () => {
    it('should keep an expanded older group open after isActive flips back to true', async () => {
      const { rerender } = render(
        <ChatActivityGroup summaryVerbPast='Explored' summaryVerbActive='Exploring' summaryDetail='2 files'>
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      await userEvent.click(screen.getByRole('button'));
      expect(screen.getByTestId('child')).toBeInTheDocument();

      rerender(
        <ChatActivityGroup summaryVerbPast='Explored' summaryVerbActive='Exploring' summaryDetail='2 files' isActive>
          <div data-testid='child'>row marker</div>
        </ChatActivityGroup>,
      );

      // With isActive=true and no user collapse, group renders inline (no button)
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.getByTestId('child')).toBeInTheDocument();
    });
  });
});
