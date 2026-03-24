import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ContextUsageData } from '@taucad/chat';
import { TooltipProvider } from '#components/ui/tooltip.js';
import { ChatContextIndicatorDisplay, getFillColor, getTrackColor } from '#components/chat/chat-context-indicator.js';

function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

const createUsageData = (overrides?: Partial<ContextUsageData>): ContextUsageData => ({
  type: 'context-usage',
  id: 'dat_test',
  totalInputTokens: 108_200,
  contextWindow: 200_000,
  percentUsed: 54.1,
  modelId: 'anthropic-claude-haiku-4.5',
  ...overrides,
});

describe('ChatContextIndicatorDisplay', () => {
  it('should render a meter element', () => {
    renderWithProviders(<ChatContextIndicatorDisplay data={createUsageData()} />);

    const meter = screen.getByRole('meter');
    expect(meter).toBeInTheDocument();
    expect(meter).toHaveAttribute('aria-valuenow', '54.1');
  });

  it('should render an SVG with two circles', () => {
    const { container } = renderWithProviders(<ChatContextIndicatorDisplay data={createUsageData()} />);

    const circles = container.querySelectorAll('circle');
    expect(circles).toHaveLength(2);
  });

  it('should show detailed tooltip on hover', async () => {
    renderWithProviders(<ChatContextIndicatorDisplay data={createUsageData()} />);

    const meter = screen.getByRole('meter');
    await userEvent.hover(meter);

    const tooltips = await screen.findAllByText(/54\.1% context used/);
    expect(tooltips.length).toBeGreaterThanOrEqual(1);

    const details = await screen.findAllByText(/108,200 \/ 200,000/);
    expect(details.length).toBeGreaterThanOrEqual(1);
  });

  it('should clamp aria-valuenow at 100 for overflow', () => {
    renderWithProviders(<ChatContextIndicatorDisplay data={createUsageData({ percentUsed: 120 })} />);

    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('aria-valuenow', '100');
  });
});

describe('getFillColor', () => {
  it('should return muted stroke for low usage', () => {
    expect(getFillColor(30)).toContain('foreground');
  });

  it('should return warning stroke for moderate usage', () => {
    expect(getFillColor(60)).toContain('warning');
  });

  it('should return destructive stroke for high usage', () => {
    expect(getFillColor(85)).toContain('destructive');
  });
});

describe('getTrackColor', () => {
  it('should return muted track for low usage', () => {
    expect(getTrackColor(30)).toContain('foreground');
  });

  it('should return warning track for moderate usage', () => {
    expect(getTrackColor(70)).toContain('warning');
  });

  it('should return destructive track for high usage', () => {
    expect(getTrackColor(90)).toContain('destructive');
  });
});
