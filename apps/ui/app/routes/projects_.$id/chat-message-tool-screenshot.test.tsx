// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ToolInvocation } from '@taucad/chat';
import type { toolName } from '@taucad/chat/constants';
import { ChatMessageToolScreenshot } from '#routes/projects_.$id/chat-message-tool-screenshot.js';

vi.mock('#components/chat/chat-tool-card.js', () => ({
  ChatToolCard({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
    return <div data-testid='chat-tool-card'>{children}</div>;
  },
  ChatToolCardHeader({
    children,
    className,
  }: {
    readonly children: React.ReactNode;
    readonly className?: string;
  }): React.JSX.Element {
    return (
      <div data-testid='chat-tool-card-header' data-classname={className ?? ''}>
        {children}
      </div>
    );
  },
  ChatToolCardIcon({ tone }: { readonly tone?: string }): React.JSX.Element {
    return <span data-testid='chat-tool-card-icon' data-tone={tone ?? ''} />;
  },
  ChatToolCardTitle({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
    return <div data-testid='chat-tool-card-title'>{children}</div>;
  },
  ChatToolCardContent({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
    return <div>{children}</div>;
  },
}));

vi.mock('#components/chat/chat-tool-text.js', () => ({
  ChatToolDescription({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
    return <span data-testid='chat-tool-description'>{children}</span>;
  },
}));

vi.mock('#components/chat/chat-tool-label.js', () => ({
  ChatToolLabel({
    verb,
    children,
  }: {
    readonly verb: React.ReactNode;
    readonly children?: React.ReactNode;
  }): React.JSX.Element {
    return (
      <span data-testid='chat-tool-label'>
        <span data-testid='chat-tool-verb'>{verb}</span>
        {children ? <> {children}</> : undefined}
      </span>
    );
  },
}));

vi.mock('#components/chat/chat-tool-error.js', () => ({
  ChatToolError({ errorText }: { readonly errorText: string }): React.JSX.Element {
    return <div data-testid='chat-tool-error'>{errorText}</div>;
  },
}));

vi.mock('#components/files/viewer-link.js', () => ({
  ViewerLink({ children, path }: { readonly children: React.ReactNode; readonly path: string }): React.JSX.Element {
    return (
      <a data-testid='viewer-link' data-path={path} href={`#${path}`}>
        {children}
      </a>
    );
  },
}));

type ScreenshotInvocation = ToolInvocation<typeof toolName.screenshot>;
type ScreenshotOutputAvailable = Extract<ScreenshotInvocation, { state: 'output-available' }>;
type ScreenshotInputAvailable = Extract<ScreenshotInvocation, { state: 'input-available' }>;

const buildOutputPart = (
  targetFile: string,
  mode: 'single' | 'multi_angle',
  output: ScreenshotOutputAvailable['output'],
): ScreenshotOutputAvailable => ({
  type: 'tool-screenshot',
  toolCallId: 'tc_1',
  state: 'output-available',
  input: { mode, targetFile },
  output,
});

const buildInputPart = (targetFile: string, mode: 'single' | 'multi_angle'): ScreenshotInputAvailable => ({
  type: 'tool-screenshot',
  toolCallId: 'tc_1',
  state: 'input-available',
  input: { mode, targetFile },
});

afterEach(() => {
  cleanup();
});

describe('ChatMessageToolScreenshot — file-aware titles', () => {
  it('should render "Captured 1 screenshot of <filename>" with a muted (untoned) leading icon', () => {
    const part = buildOutputPart('lib/skids.ts', 'single', {
      images: [{ view: 'current', dataUrl: 'data:image/png;base64,abc' }],
    });

    render(<ChatMessageToolScreenshot part={part} />);

    const title = screen.getByTestId('chat-tool-card-title');
    expect(title.textContent).toContain('Captured');
    expect(title.textContent).toContain('1 screenshot of');
    expect(title.textContent).toContain('lib/skids.ts');
    expect(title.textContent).not.toMatch(/screenshots/);

    expect(screen.getByTestId('chat-tool-verb').textContent).toBe('Captured');
    expect(screen.getByTestId('chat-tool-description').textContent).toContain('1 screenshot of');

    const link = screen.getByTestId('viewer-link');
    expect(link.dataset['path']).toBe('lib/skids.ts');

    // Success states deliberately stay muted — the leading icon carries no
    // tone so only failures (red) draw the eye.
    const header = screen.getByTestId('chat-tool-card-header');
    expect(header.dataset['classname']).toBe('');
    expect(screen.getByTestId('chat-tool-card-icon').dataset['tone']).toBe('');
  });

  it('should render "Captured 6 screenshots of <filename>" for a composite multi-angle result', () => {
    const part = buildOutputPart('main.ts', 'multi_angle', {
      images: [{ view: 'composite', dataUrl: 'data:image/png;base64,abc' }],
    });

    render(<ChatMessageToolScreenshot part={part} />);

    const title = screen.getByTestId('chat-tool-card-title');
    expect(title.textContent).toContain('Captured 6 screenshots of');
    expect(title.textContent).toContain('main.ts');

    const link = screen.getByTestId('viewer-link');
    expect(link.dataset['path']).toBe('main.ts');
  });

  it('should render "Captured N screenshots of <filename>" for a non-composite multi-image result', () => {
    const part = buildOutputPart('main.ts', 'multi_angle', {
      images: [
        { view: 'front', dataUrl: 'data:image/png;base64,a' },
        { view: 'back', dataUrl: 'data:image/png;base64,b' },
        { view: 'left', dataUrl: 'data:image/png;base64,c' },
      ],
    });

    render(<ChatMessageToolScreenshot part={part} />);

    const title = screen.getByTestId('chat-tool-card-title');
    expect(title.textContent).toContain('Captured 3 screenshots of');
    expect(title.textContent).toContain('main.ts');
  });

  it('should render "Capturing orthographic views of <filename>..." while loading multi-angle', () => {
    const part = buildInputPart('lib/skids.ts', 'multi_angle');

    render(<ChatMessageToolScreenshot part={part} />);

    const title = screen.getByTestId('chat-tool-card-title');
    expect(title.textContent).toContain('Capturing');
    expect(title.textContent).toContain('orthographic views of');
    expect(title.textContent).toContain('lib/skids.ts');

    const link = screen.getByTestId('viewer-link');
    expect(link.dataset['path']).toBe('lib/skids.ts');
  });

  it('should render "Capturing screenshot of <filename>..." while loading single mode', () => {
    const part = buildInputPart('main.ts', 'single');

    render(<ChatMessageToolScreenshot part={part} />);

    const title = screen.getByTestId('chat-tool-card-title');
    expect(title.textContent).toContain('Capturing');
    expect(title.textContent).toContain('screenshot of');
    expect(title.textContent).toContain('main.ts');
  });
});
