// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { CaptureViewScreenshotOptions } from '#components/chat/capture-view-screenshot.utils.js';

const mockAddDraftImage = vi.fn();
const mockTrigger = vi.fn();
const mockGraphicsRef = { send: vi.fn(), id: 'graphics-actor' };

const captureCalls: CaptureViewScreenshotOptions[] = [];
const mockCaptureViewScreenshot = vi.fn((options: CaptureViewScreenshotOptions) => {
  captureCalls.push(options);
});

vi.mock('#components/chat/capture-view-screenshot.utils.js', () => ({
  captureViewScreenshot: (options: CaptureViewScreenshotOptions) => {
    mockCaptureViewScreenshot(options);
  },
}));

vi.mock('#hooks/use-graphics.js', () => ({
  useGraphics: () => mockGraphicsRef,
}));

vi.mock('#hooks/use-chat.js', () => ({
  useChatActions: () => ({ addDraftImage: mockAddDraftImage }),
}));

vi.mock('#hooks/use-image-quality.js', () => ({
  useImageQuality: () => ({ quality: 0.42, setQuality: vi.fn() }),
}));

vi.mock('#hooks/use-tick-animation.js', () => ({
  useTickAnimation: () => ({ ticked: false, trigger: mockTrigger }),
}));

vi.mock('#components/ui/sonner.js', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Tooltip + DropdownMenuItem render their children directly so we can
// interact with the underlying button via testing-library.
vi.mock('#components/ui/tooltip.js', () => ({
  Tooltip: ({ children }: { readonly children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { readonly children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { readonly children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('#components/ui/button.js', () => ({
  Button: ({ children, onClick }: { readonly children: React.ReactNode; readonly onClick?: () => void }) => (
    <button type='button' onClick={onClick} data-testid='capture-button'>
      {children}
    </button>
  ),
}));

vi.mock('#components/ui/dropdown-menu.js', () => ({
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    readonly children: React.ReactNode;
    readonly onSelect?: () => void;
  }) => (
    <button type='button' onClick={onSelect} data-testid='capture-overflow-button'>
      {children}
    </button>
  ),
}));

const { CaptureViewControl, CaptureViewOverflowControl } =
  await import('#components/geometry/cad/capture-view-control.js');

describe('CaptureViewControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captureCalls.length = 0;
  });

  it('invokes captureViewScreenshot with the per-view graphicsRef + cookie quality on click', async () => {
    const user = userEvent.setup();
    render(<CaptureViewControl />);

    await user.click(screen.getByTestId('capture-button'));

    expect(mockCaptureViewScreenshot).toHaveBeenCalledOnce();
    const call = captureCalls[0]!;
    expect(call.graphicsRef).toBe(mockGraphicsRef);
    expect(call.quality).toBe(0.42);
    expect(call.activeActors).toBeInstanceOf(Set);
  });

  it('forwards the raw screenshot data URL to addDraftImage (machine resizes downstream — R1)', async () => {
    const user = userEvent.setup();
    render(<CaptureViewControl />);

    await user.click(screen.getByTestId('capture-button'));

    const oversizedRaw = `data:image/webp;base64,${'A'.repeat(2_000_000)}`;
    captureCalls[0]!.onImage(oversizedRaw);

    expect(mockAddDraftImage).toHaveBeenCalledExactlyOnceWith(oversizedRaw);
    expect(mockTrigger).toHaveBeenCalledOnce();
  });

  it('overflow variant forwards the raw screenshot data URL to addDraftImage (R1)', async () => {
    const user = userEvent.setup();
    render(<CaptureViewOverflowControl />);

    await user.click(screen.getByTestId('capture-overflow-button'));

    expect(mockCaptureViewScreenshot).toHaveBeenCalledOnce();
    const oversizedRaw = `data:image/webp;base64,${'B'.repeat(2_000_000)}`;
    captureCalls[0]!.onImage(oversizedRaw);
    expect(mockAddDraftImage).toHaveBeenCalledExactlyOnceWith(oversizedRaw);
  });
});
