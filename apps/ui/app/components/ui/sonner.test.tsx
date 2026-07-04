import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ToasterProps } from 'sonner';
import { Toaster } from '#components/ui/sonner.js';

const toasterState = vi.hoisted(() => ({
  isMobile: false,
  calls: [] as ToasterProps[],
}));

vi.mock('#hooks/use-theme.js', () => ({
  useTheme: () => ({ theme: 'dark' }),
}));

vi.mock('#hooks/use-mobile.js', () => ({
  useIsMobile: () => toasterState.isMobile,
}));

vi.mock('sonner', () => ({
  Toaster: (properties: ToasterProps) => {
    toasterState.calls.push(properties);
    return null;
  },
  toast: {},
}));

beforeEach(() => {
  toasterState.isMobile = false;
  toasterState.calls.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('Toaster', () => {
  it('leaves desktop placement on Sonner defaults', () => {
    render(<Toaster />);

    const properties = toasterState.calls[0]!;
    expect(properties.theme).toBe('dark');
    expect(properties.position).toBeUndefined();
    expect(properties.closeButton).toBeUndefined();
    expect(properties.offset).toBeUndefined();
  });

  it('keeps mobile toasts away from bottom controls', () => {
    toasterState.isMobile = true;

    render(<Toaster />);

    const properties = toasterState.calls[0]!;
    expect(properties.position).toBe('bottom-center');
    expect(properties.closeButton).toBe(true);
    expect(properties.offset).toEqual({
      top: 'calc(env(safe-area-inset-top) + var(--header-height, 3.3rem) + var(--spacing) * 4)',
      right: 'calc(var(--spacing) * 3)',
      bottom: 'calc(env(safe-area-inset-bottom) + 7rem)',
      left: 'calc(var(--spacing) * 3)',
    });
    expect(properties.mobileOffset).toEqual(properties.offset);
    expect(properties.swipeDirections).toEqual(['bottom', 'left', 'right']);
  });

  it('lets explicit toaster props override mobile defaults', () => {
    toasterState.isMobile = true;

    render(
      <Toaster closeButton={false} mobileOffset={32} offset={24} position='bottom-left' swipeDirections={['bottom']} />,
    );

    const properties = toasterState.calls[0]!;
    expect(properties.position).toBe('bottom-left');
    expect(properties.closeButton).toBe(false);
    expect(properties.offset).toBe(24);
    expect(properties.mobileOffset).toBe(32);
    expect(properties.swipeDirections).toEqual(['bottom']);
  });
});
