import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { TriangleAlert } from 'lucide-react';
import type { ToolExecutionError } from '@taucad/chat';
import { ChatToolError, StructuredToolError } from '#components/chat/chat-tool-error.js';

vi.mock('#hooks/use-cookie.js', () => ({
  useCookie: (_name: string, defaultValue: boolean) => [defaultValue, vi.fn(), vi.fn()],
}));

const createError = (
  errorCode: ToolExecutionError['errorCode'],
  overrides: Partial<ToolExecutionError> = {},
): ToolExecutionError => {
  // oxlint-disable-next-line typescript-eslint(consistent-type-assertions) -- test factory for discriminated union
  return {
    errorCode,
    message: 'Test error message',
    toolName: 'test_tool',
    toolCallId: 'call-1',
    ...overrides,
  } as ToolExecutionError;
};

describe('StructuredToolError', () => {
  it('should render destructive tone on the leading icon (not the header text) for TOOL_EXECUTION_ERROR', () => {
    render(<StructuredToolError error={createError('TOOL_EXECUTION_ERROR')} />);

    const trigger = screen.getByRole('button');
    // Header text stays muted — color only lives on the leading icon.
    expect(trigger.className).not.toContain('text-destructive');

    const icon = trigger.querySelector('svg');
    expect(icon?.getAttribute('class') ?? '').toContain('text-destructive');
  });

  it('should render with muted (non-destructive) header and icon for TOOL_NO_RESULTS', () => {
    render(<StructuredToolError error={createError('TOOL_NO_RESULTS')} />);

    const trigger = screen.getByRole('button');
    expect(trigger.className).not.toContain('text-destructive');

    const icon = trigger.querySelector('svg');
    expect(icon?.getAttribute('class') ?? '').not.toContain('text-destructive');
  });

  it('should render with muted (non-destructive) header and icon for USER_INTERRUPTED', () => {
    render(<StructuredToolError error={createError('USER_INTERRUPTED')} />);

    const trigger = screen.getByRole('button');
    expect(trigger.className).not.toContain('text-destructive');

    const icon = trigger.querySelector('svg');
    expect(icon?.getAttribute('class') ?? '').not.toContain('text-destructive');
  });

  it('should render every error inside a collapsible (trigger present, body initially closed)', () => {
    render(<StructuredToolError error={createError('TOOL_NO_RESULTS')} />);

    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(screen.queryByText('Test error message')).not.toBeInTheDocument();
  });

  it('should render the verb and tool name in the header with proper inline spacing via ChatToolLabel', () => {
    render(<StructuredToolError error={createError('TOOL_EXECUTION_ERROR', { toolName: 'web_browser' })} />);

    const verb = screen.getByText('Tool Error');
    const labelWrapper = verb.parentElement;
    expect(labelWrapper).not.toBeNull();
    expect(labelWrapper).toHaveClass('inline');

    const description = screen.getByText('web_browser');
    expect(description).toHaveClass('font-mono');
    expect(description).toHaveClass('text-foreground/50');

    expect(labelWrapper?.textContent).toBe('Tool Error web_browser');
  });

  it('should put the error description inside the collapsible body, not the header', async () => {
    render(<StructuredToolError error={createError('TOOL_EXECUTION_ERROR')} />);

    expect(screen.queryByText('Test error message')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button'));

    expect(screen.getByText('Test error message')).toBeInTheDocument();
  });

  it('should render the validation errors block inside the body when expanded', async () => {
    const error = createError('TOOL_INPUT_VALIDATION_FAILED', {
      validationErrors: [{ path: 'input.name', message: 'Required' }],
    });
    render(<StructuredToolError error={error} />);

    expect(screen.queryByText('Validation Errors:')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button'));

    expect(screen.getByText('Validation Errors:')).toBeInTheDocument();
    expect(screen.getByText('input.name')).toBeInTheDocument();
    expect(screen.getByText(/Required/)).toBeInTheDocument();
  });
});

describe('ChatToolError unparseable fallback', () => {
  it('should render the fallback title in the header', () => {
    render(<ChatToolError errorText='not json at all' fallbackIcon={TriangleAlert} fallbackTitle='Boom' />);

    expect(screen.getByText('Boom')).toBeInTheDocument();
  });

  it('should render destructive tone on the fallback icon (not the header text)', () => {
    render(<ChatToolError errorText='not json at all' fallbackIcon={TriangleAlert} fallbackTitle='Boom' />);

    const trigger = screen.getByRole('button');
    expect(trigger.className).not.toContain('text-destructive');

    const icon = trigger.querySelector('svg');
    expect(icon?.getAttribute('class') ?? '').toContain('text-destructive');
  });

  it('should render the fallback inside a collapsible (trigger present, raw text initially hidden)', () => {
    render(<ChatToolError errorText='raw error blob' fallbackIcon={TriangleAlert} fallbackTitle='Boom' />);

    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(screen.queryByText('raw error blob')).not.toBeInTheDocument();
  });

  it('should reveal the raw errorText in the body after expanding the fallback', async () => {
    render(<ChatToolError errorText='raw error blob' fallbackIcon={TriangleAlert} fallbackTitle='Boom' />);

    await userEvent.click(screen.getByRole('button'));

    expect(screen.getByText('raw error blob')).toBeInTheDocument();
  });
});
