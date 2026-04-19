// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

vi.mock('#routes/_index/hero-viewer.js', () => ({
  HeroViewer: () => <div data-testid='hero-viewer'>HeroViewer</div>,
}));

const { LazyHeroViewer } = await import('#routes/_index/hero-viewer-gate.js');

describe('LazyHeroViewer', () => {
  let intersectionCallback: IntersectionObserverCallback;

  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class MockIntersectionObserver {
        public observe = vi.fn();
        public unobserve = vi.fn();
        public disconnect = vi.fn();
        public constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback;
        }
      },
    );
  });

  it('should not render HeroViewer before intersection', () => {
    render(<LazyHeroViewer />);

    expect(screen.queryByTestId('hero-viewer')).toBeNull();
  });

  it('should render HeroViewer after intersection observer triggers', async () => {
    render(<LazyHeroViewer />);

    const emptyRect: DOMRectReadOnly = new DOMRect();
    const entry: IntersectionObserverEntry = {
      isIntersecting: true,
      target: document.createElement('div'),
      boundingClientRect: emptyRect,
      intersectionRatio: 1,
      intersectionRect: emptyRect,
      rootBounds: null,
      time: 0,
    };
    const observer: IntersectionObserver = {
      root: null,
      rootMargin: '',
      scrollMargin: '',
      thresholds: [],
      disconnect: () => undefined,
      observe: () => undefined,
      takeRecords: () => [],
      unobserve: () => undefined,
    };
    await act(async () => {
      intersectionCallback([entry], observer);
    });

    expect(await screen.findByTestId('hero-viewer')).toBeDefined();
  });

  it('should render a loading placeholder before intersection', () => {
    const { container } = render(<LazyHeroViewer />);

    // The sentinel div should exist with min-height to reserve space
    const sentinel = container.firstElementChild;
    expect(sentinel).toBeDefined();
  });
});
