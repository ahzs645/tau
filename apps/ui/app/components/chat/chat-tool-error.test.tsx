import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ToolExecutionError } from '@taucad/chat';
import { StructuredToolError } from '#components/chat/chat-tool-error.js';

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
  it('should render with destructive styling for TOOL_EXECUTION_ERROR', () => {
    render(<StructuredToolError error={createError('TOOL_EXECUTION_ERROR')} />);

    const title = screen.getByText('Tool Error');
    expect(title.className).toContain('text-destructive');
  });

  it('should render with muted styling for TOOL_NO_RESULTS', () => {
    render(<StructuredToolError error={createError('TOOL_NO_RESULTS')} />);

    const title = screen.getByText('No Results');
    expect(title.className).not.toContain('text-destructive');
  });

  it('should render with muted styling for USER_INTERRUPTED', () => {
    render(<StructuredToolError error={createError('USER_INTERRUPTED')} />);

    const title = screen.getByText('Interrupted');
    expect(title.className).not.toContain('text-destructive');
  });

  it('should render inline without card border for no-details errors', () => {
    const { container } = render(<StructuredToolError error={createError('TOOL_NO_RESULTS')} />);

    const wrapper = container.firstElementChild!;
    expect(wrapper.className).not.toMatch(/\bborder\b/);
    expect(wrapper.className).not.toContain('bg-neutral/10');
  });

  it('should display tool name and description', () => {
    render(<StructuredToolError error={createError('TOOL_EXECUTION_ERROR', { toolName: 'web_browser' })} />);

    expect(screen.getByText('web_browser')).toBeDefined();
    expect(screen.getByText('Test error message')).toBeDefined();
  });
});
