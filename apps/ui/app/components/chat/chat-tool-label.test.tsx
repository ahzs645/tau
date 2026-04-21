import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatToolLabel } from '#components/chat/chat-tool-label.js';
import { ChatToolDescription } from '#components/chat/chat-tool-text.js';

describe('ChatToolLabel', () => {
  it('should render the verb in emphasised typography', () => {
    render(<ChatToolLabel verb='Read' />);

    const verbSpan = screen.getByText('Read');
    expect(verbSpan).toHaveClass('font-medium');
    expect(verbSpan).toHaveClass('text-foreground/60');
  });

  it('should brighten the verb on hover when nested in a chat-tool trigger group', () => {
    render(<ChatToolLabel verb='Read' />);

    const verbSpan = screen.getByText('Read');
    expect(verbSpan).toHaveClass('transition-colors');
    expect(verbSpan).toHaveClass('group-hover/chat-tool-trigger:text-foreground');
  });

  it('should brighten ChatToolDescription on hover one tier behind the verb', () => {
    render(
      <ChatToolLabel verb='Searched'>
        <ChatToolDescription>react testing</ChatToolDescription>
      </ChatToolLabel>,
    );

    const detail = screen.getByText('react testing');
    expect(detail).toHaveClass('transition-colors');
    expect(detail).toHaveClass('group-hover/chat-tool-trigger:text-foreground/80');
  });

  it('should render verb + plain text child separated by a single literal space', () => {
    const { container } = render(<ChatToolLabel verb='Read'>main.kcl</ChatToolLabel>);

    expect(container.textContent).toBe('Read main.kcl');
  });

  it('should compose with ChatToolDescription for the muted detail typography', () => {
    render(
      <ChatToolLabel verb='Searched'>
        <ChatToolDescription>react testing</ChatToolDescription>
      </ChatToolLabel>,
    );

    const detail = screen.getByText('react testing');
    expect(detail).toHaveClass('text-foreground/50');
    expect(detail).toHaveClass('font-normal');
  });

  it('should render verb only when no children are passed', () => {
    const { container } = render(<ChatToolLabel verb='All tests passed' />);

    expect(container.textContent).toBe('All tests passed');
  });

  it('should treat empty-string children as no detail', () => {
    const { container } = render(<ChatToolLabel verb='Listing'>{''}</ChatToolLabel>);

    expect(container.textContent).toBe('Listing');
  });

  it('should preserve the inline phrase exactly without extra whitespace', () => {
    const { container } = render(
      <ChatToolLabel verb='Explored'>
        <ChatToolDescription>12 searches, 2 fetches</ChatToolDescription>
      </ChatToolLabel>,
    );

    expect(container.textContent).toBe('Explored 12 searches, 2 fetches');
  });

  it('should apply the inline layout primitives to the outer wrapper', () => {
    render(
      <ChatToolLabel verb='Listed'>
        <ChatToolDescription>app/utils</ChatToolDescription>
      </ChatToolLabel>,
    );

    const verbSpan = screen.getByText('Listed');
    const wrapper = verbSpan.parentElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveClass('inline');
    expect(wrapper).toHaveClass('min-w-0');
    expect(wrapper).toHaveClass('truncate');
  });

  it('should accept and merge a custom className on the wrapper', () => {
    render(<ChatToolLabel verb='Read' className='font-mono' />);

    const wrapper = screen.getByText('Read').parentElement;
    expect(wrapper).toHaveClass('font-mono');
    expect(wrapper).toHaveClass('inline');
  });
});
