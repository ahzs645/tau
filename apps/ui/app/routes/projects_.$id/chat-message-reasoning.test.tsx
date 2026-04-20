// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { ReasoningUIPart } from 'ai';
import { ChatMessageReasoning } from '#routes/projects_.$id/chat-message-reasoning.js';

const { mockChatStatus } = vi.hoisted(() => ({
  mockChatStatus: { current: 'streaming' as 'streaming' | 'idle' },
}));

vi.mock('#hooks/use-chat.js', () => ({
  useChatSelector<T>(selector: (state: { status: 'streaming' | 'idle' }) => T): T {
    return selector({ status: mockChatStatus.current });
  },
}));

vi.mock('#components/markdown/markdown-viewer-chat.js', () => ({
  MarkdownViewerChat({ children }: { readonly children: string }): React.JSX.Element {
    return <div data-testid='markdown-content'>{children}</div>;
  },
}));

vi.mock('#components/chat/chat-tool-card.js', () => ({
  ChatToolCard({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
    return <div data-testid='chat-tool-card'>{children}</div>;
  },
  ChatToolCardHeader({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
    return <div>{children}</div>;
  },
  ChatToolCardTitle({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
    return <div>{children}</div>;
  },
}));

type ResizeObserverHarness = {
  callback: ResizeObserverCallback | undefined;
  constructions: number;
  observed: Element[];
  disconnects: number;
};

const harness: ResizeObserverHarness = {
  callback: undefined,
  constructions: 0,
  observed: [],
  disconnects: 0,
};

class TestResizeObserver implements ResizeObserver {
  public constructor(callback: ResizeObserverCallback) {
    harness.callback = callback;
    harness.constructions += 1;
  }

  public observe(target: Element): void {
    harness.observed.push(target);
  }

  public unobserve(): void {
    // No-op
  }

  public disconnect(): void {
    harness.disconnects += 1;
  }
}

const installScrollMetrics = (
  element: HTMLElement,
  metrics: { scrollHeight?: number; clientHeight?: number; scrollTop?: number },
): void => {
  if (metrics.scrollHeight !== undefined) {
    Object.defineProperty(element, 'scrollHeight', {
      configurable: true,
      get: () => metrics.scrollHeight,
    });
  }

  if (metrics.clientHeight !== undefined) {
    Object.defineProperty(element, 'clientHeight', {
      configurable: true,
      get: () => metrics.clientHeight,
    });
  }

  if (metrics.scrollTop !== undefined) {
    let value = metrics.scrollTop;
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get: () => value,
      set: (next: number) => {
        value = next;
      },
    });
  }
};

const updateScrollHeight = (element: HTMLElement, scrollHeight: number): void => {
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });
};

const flushAnimationFrames = (): void => {
  // Drain repeatedly: a callback may schedule another frame.
  let safety = 32;
  while (pendingRafCallbacks.size > 0 && safety > 0) {
    const callbacks = [...pendingRafCallbacks.entries()];
    pendingRafCallbacks.clear();
    for (const [, callback] of callbacks) {
      callback(performance.now());
    }
    safety -= 1;
  }
};

const triggerResize = (): void => {
  if (!harness.callback) {
    throw new Error('ResizeObserver callback not registered');
  }

  act(() => {
    harness.callback?.([], {
      observe() {
        // No-op
      },
      unobserve() {
        // No-op
      },
      disconnect() {
        // No-op
      },
    });
    flushAnimationFrames();
  });
};

const dispatchScroll = (element: HTMLElement): void => {
  act(() => {
    element.dispatchEvent(new Event('scroll'));
  });
};

const dispatchWheel = (element: HTMLElement): void => {
  act(() => {
    element.dispatchEvent(new Event('wheel'));
  });
};

const dispatchPointerDown = (element: HTMLElement): void => {
  act(() => {
    element.dispatchEvent(new Event('pointerdown'));
  });
};

const createReasoningPart = (text = 'Some streaming reasoning text'): ReasoningUIPart => ({
  type: 'reasoning',
  text,
  state: 'streaming',
});

const createReasoningPartWithTiming = (
  options: {
    readonly text?: string;
    readonly state?: 'streaming' | 'done';
    readonly reasoningStartedAtMs?: number;
    readonly reasoningEndedAtMs?: number;
  } = {},
): ReasoningUIPart => {
  const { text = 'Some reasoning text', state = 'done', reasoningStartedAtMs, reasoningEndedAtMs } = options;
  const common: Record<string, number> = {};
  if (reasoningStartedAtMs !== undefined) {
    common['reasoningStartedAtMs'] = reasoningStartedAtMs;
  }
  if (reasoningEndedAtMs !== undefined) {
    common['reasoningEndedAtMs'] = reasoningEndedAtMs;
  }
  const providerMetadata =
    Object.keys(common).length > 0 ? ({ common } satisfies Record<string, Record<string, number>>) : undefined;
  return { type: 'reasoning', text, state, providerMetadata };
};

const getElements = (): { scrollContainer: HTMLElement; content: HTMLElement } => {
  const markdown = screen.getByTestId('markdown-content');
  const content = markdown.parentElement;
  const scrollContainer = content?.parentElement;

  if (!content || !scrollContainer) {
    throw new Error('Could not locate scroll container or content element');
  }

  return { scrollContainer, content };
};

const originalResizeObserver = globalThis.ResizeObserver;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

let pendingRafCallbacks: Map<number, FrameRequestCallback>;
let nextRafHandle = 0;

beforeEach(() => {
  harness.callback = undefined;
  harness.constructions = 0;
  harness.observed = [];
  harness.disconnects = 0;
  mockChatStatus.current = 'streaming';
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

  // Queue RAF callbacks; tests flush them via triggerResize() so the observer-
  // driven pin is assertable. We can't run them synchronously inside
  // requestAnimationFrame() because the implementation assigns the returned
  // handle to a `pinFrame` cursor *after* the call — a synchronous callback
  // would set pinFrame = 0 then immediately be overwritten by the handle,
  // leaving subsequent schedulePin() calls short-circuiting forever.
  pendingRafCallbacks = new Map();
  nextRafHandle = 0;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
    nextRafHandle += 1;
    const handle = nextRafHandle;
    pendingRafCallbacks.set(handle, callback);
    return handle;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((handle: number): void => {
    pendingRafCallbacks.delete(handle);
  }) as typeof cancelAnimationFrame;
});

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
});

describe('ChatMessageReasoning', () => {
  describe('preview auto-pin', () => {
    it('should pin scrollTop to scrollHeight on attach during streaming', () => {
      render(<ChatMessageReasoning part={createReasoningPart()} hasContent={false} />);

      const { scrollContainer } = getElements();
      installScrollMetrics(scrollContainer, { scrollHeight: 500, clientHeight: 192, scrollTop: 0 });

      // The synchronous attach pin runs before metrics were installed; replay via the observer.
      triggerResize();

      expect(scrollContainer.scrollTop).toBe(500);
    });

    it('should pin to the new scrollHeight when the ResizeObserver fires while sticky', () => {
      render(<ChatMessageReasoning part={createReasoningPart()} hasContent={false} />);

      const { scrollContainer } = getElements();
      installScrollMetrics(scrollContainer, { scrollHeight: 500, clientHeight: 192, scrollTop: 308 });

      triggerResize();
      expect(scrollContainer.scrollTop).toBe(500);

      updateScrollHeight(scrollContainer, 800);
      triggerResize();

      expect(scrollContainer.scrollTop).toBe(800);
    });

    it('should ignore programmatic scroll events that are not preceded by a user-input event', () => {
      // Regression: previously, the scroll event from a programmatic pin could fire
      // AFTER more content arrived, computing a large distance-from-bottom and
      // erroneously releasing stickiness, leaving the user stuck near the top.
      render(<ChatMessageReasoning part={createReasoningPart()} hasContent={false} />);

      const { scrollContainer } = getElements();
      installScrollMetrics(scrollContainer, { scrollHeight: 300, clientHeight: 192, scrollTop: 0 });

      triggerResize();
      expect(scrollContainer.scrollTop).toBe(300);

      // Simulate "deferred scroll task fires AFTER content has grown beyond the
      // value pin() set scrollTop to" — distance-from-bottom is now huge.
      updateScrollHeight(scrollContainer, 600);
      dispatchScroll(scrollContainer);

      // Without a user-input precursor, the scroll listener must not release.
      updateScrollHeight(scrollContainer, 700);
      triggerResize();

      expect(scrollContainer.scrollTop).toBe(700);
    });

    it('should pause auto-pinning after a user wheel scroll moves away from the bottom', () => {
      render(<ChatMessageReasoning part={createReasoningPart()} hasContent={false} />);

      const { scrollContainer } = getElements();
      installScrollMetrics(scrollContainer, { scrollHeight: 500, clientHeight: 192, scrollTop: 308 });

      triggerResize();
      expect(scrollContainer.scrollTop).toBe(500);

      dispatchWheel(scrollContainer);
      scrollContainer.scrollTop = 100;
      dispatchScroll(scrollContainer);

      updateScrollHeight(scrollContainer, 800);
      triggerResize();

      expect(scrollContainer.scrollTop).toBe(100);
    });

    it('should resume auto-pinning when the user scrolls back to the bottom', () => {
      render(<ChatMessageReasoning part={createReasoningPart()} hasContent={false} />);

      const { scrollContainer } = getElements();
      installScrollMetrics(scrollContainer, { scrollHeight: 500, clientHeight: 192, scrollTop: 308 });

      triggerResize();

      dispatchWheel(scrollContainer);
      scrollContainer.scrollTop = 100;
      dispatchScroll(scrollContainer);

      updateScrollHeight(scrollContainer, 800);
      triggerResize();
      expect(scrollContainer.scrollTop).toBe(100);

      dispatchWheel(scrollContainer);
      scrollContainer.scrollTop = 608;
      dispatchScroll(scrollContainer);

      updateScrollHeight(scrollContainer, 1000);
      triggerResize();

      expect(scrollContainer.scrollTop).toBe(1000);
    });

    it('should detect scrollbar drag via pointerdown and release stickiness', () => {
      render(<ChatMessageReasoning part={createReasoningPart()} hasContent={false} />);

      const { scrollContainer } = getElements();
      installScrollMetrics(scrollContainer, { scrollHeight: 500, clientHeight: 192, scrollTop: 308 });

      triggerResize();

      dispatchPointerDown(scrollContainer);
      scrollContainer.scrollTop = 50;
      dispatchScroll(scrollContainer);

      updateScrollHeight(scrollContainer, 900);
      triggerResize();

      expect(scrollContainer.scrollTop).toBe(50);
    });

    it('should treat distance-from-bottom equal to the 8px tolerance as still sticky', () => {
      render(<ChatMessageReasoning part={createReasoningPart()} hasContent={false} />);

      const { scrollContainer } = getElements();
      installScrollMetrics(scrollContainer, { scrollHeight: 500, clientHeight: 192, scrollTop: 308 });

      triggerResize();

      dispatchWheel(scrollContainer);
      scrollContainer.scrollTop = 300;
      dispatchScroll(scrollContainer);

      updateScrollHeight(scrollContainer, 800);
      triggerResize();

      expect(scrollContainer.scrollTop).toBe(800);
    });

    it('should release stickiness when distance-from-bottom exceeds the 8px tolerance', () => {
      render(<ChatMessageReasoning part={createReasoningPart()} hasContent={false} />);

      const { scrollContainer } = getElements();
      installScrollMetrics(scrollContainer, { scrollHeight: 500, clientHeight: 192, scrollTop: 308 });

      triggerResize();

      dispatchWheel(scrollContainer);
      scrollContainer.scrollTop = 299;
      dispatchScroll(scrollContainer);

      updateScrollHeight(scrollContainer, 800);
      triggerResize();

      expect(scrollContainer.scrollTop).toBe(299);
    });
  });

  describe('gating', () => {
    it('should not construct a ResizeObserver when not streaming', () => {
      mockChatStatus.current = 'idle';

      render(<ChatMessageReasoning part={createReasoningPart()} hasContent={false} />);

      expect(harness.constructions).toBe(0);
    });

    it('should not construct a ResizeObserver when reasoning is collapsed (hasContent and no toggle)', () => {
      render(<ChatMessageReasoning part={createReasoningPart()} hasContent />);

      expect(harness.constructions).toBe(0);
    });
  });

  describe('ref attachment lifecycle', () => {
    it('should attach the observer once reasoning text arrives after an empty initial render', () => {
      const { rerender } = render(<ChatMessageReasoning part={createReasoningPart('')} hasContent={false} />);

      expect(harness.constructions).toBe(0);
      expect(screen.queryByTestId('markdown-content')).toBeNull();

      rerender(<ChatMessageReasoning part={createReasoningPart('first token')} hasContent={false} />);

      expect(harness.constructions).toBe(1);

      const { scrollContainer } = getElements();
      installScrollMetrics(scrollContainer, { scrollHeight: 500, clientHeight: 192, scrollTop: 0 });
      triggerResize();

      expect(scrollContainer.scrollTop).toBe(500);
    });

    it('should disconnect and reconstruct the observer when text drops and then returns', () => {
      const { rerender } = render(
        <ChatMessageReasoning part={createReasoningPart('initial text')} hasContent={false} />,
      );

      expect(harness.constructions).toBe(1);
      expect(harness.disconnects).toBe(0);

      rerender(<ChatMessageReasoning part={createReasoningPart('')} hasContent={false} />);

      expect(harness.disconnects).toBe(1);
      expect(screen.queryByTestId('markdown-content')).toBeNull();

      rerender(<ChatMessageReasoning part={createReasoningPart('text again')} hasContent={false} />);

      expect(harness.constructions).toBe(2);

      const { scrollContainer } = getElements();
      installScrollMetrics(scrollContainer, { scrollHeight: 600, clientHeight: 192, scrollTop: 0 });
      triggerResize();

      expect(scrollContainer.scrollTop).toBe(600);
    });
  });

  describe('cleanup', () => {
    it('should disconnect the ResizeObserver on unmount', () => {
      const { unmount } = render(<ChatMessageReasoning part={createReasoningPart()} hasContent={false} />);

      expect(harness.constructions).toBe(1);
      expect(harness.disconnects).toBe(0);

      unmount();

      expect(harness.disconnects).toBe(1);
    });

    it('should remove all interaction listeners on unmount', () => {
      const { unmount } = render(<ChatMessageReasoning part={createReasoningPart()} hasContent={false} />);

      const { scrollContainer } = getElements();
      installScrollMetrics(scrollContainer, { scrollHeight: 500, clientHeight: 192, scrollTop: 0 });
      const removeSpy = vi.spyOn(scrollContainer, 'removeEventListener');

      unmount();

      expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('wheel', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('touchstart', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function));
    });
  });

  describe('duration label', () => {
    const mutedClass = 'text-foreground/60';

    type LabelSpans = {
      readonly button: HTMLButtonElement;
      readonly verbText: string;
      readonly suffixText?: string;
      readonly verbSpan: HTMLSpanElement;
      readonly suffixSpan?: HTMLSpanElement;
    };

    /**
     * Resolve the toggle button's two-tone label spans by walking the DOM
     * directly. testing-library's `getByText` normalizes whitespace and does
     * not match text spread across child elements, both of which interact
     * badly with the `<verb> <muted suffix>` two-tone structure under test.
     */
    const readLabelSpans = (): LabelSpans => {
      const buttons = screen.getAllByRole('button');
      const button = buttons.find((b): b is HTMLButtonElement => b.querySelector('svg.lucide-brain') !== null);
      if (!button) {
        throw new Error('could not locate the toggle button');
      }
      const labelWrapper = button.querySelector(':scope > span.flex');
      if (!labelWrapper) {
        throw new Error('could not locate the label wrapper span');
      }
      const innerSpans = labelWrapper.querySelectorAll(':scope > span');
      const verbSpan = innerSpans[0];
      const suffixSpan = innerSpans[1];
      if (!(verbSpan instanceof HTMLSpanElement)) {
        throw new Error('expected a verb span');
      }
      return {
        button,
        verbText: verbSpan.textContent,
        suffixText:
          suffixSpan instanceof HTMLSpanElement && suffixSpan.textContent ? suffixSpan.textContent : undefined,
        verbSpan,
        suffixSpan: suffixSpan instanceof HTMLSpanElement ? suffixSpan : undefined,
      };
    };

    it('should render "Thought process" fallback for done parts with no providerMetadata.common', () => {
      mockChatStatus.current = 'idle';
      render(<ChatMessageReasoning part={createReasoningPartWithTiming({ state: 'done' })} hasContent={false} />);

      const spans = readLabelSpans();
      expect(spans.verbText).toBe('Thought');
      expect(spans.suffixText?.trim()).toBe('process');
      // The legacy fallback still uses the two-tone treatment so the suffix
      // visually recedes consistently with the new states.
      expect(spans.verbSpan.className).not.toContain(mutedClass);
      expect(spans.suffixSpan?.className).toContain(mutedClass);
    });

    it('should render "Thinking…" while streaming with reasoningStartedAtMs but no reasoningEndedAtMs (sub-second)', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));
        render(
          <ChatMessageReasoning
            part={createReasoningPartWithTiming({
              state: 'streaming',
              reasoningStartedAtMs: Date.now(),
            })}
            hasContent={false}
          />,
        );

        const spans = readLabelSpans();
        expect(spans.verbText).toBe('Thinking…');
        expect(spans.suffixText).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should advance the live counter to "Thinking for 3s" after 3000ms while streaming', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));
        const startedAtMs = Date.now();

        render(
          <ChatMessageReasoning
            part={createReasoningPartWithTiming({ state: 'streaming', reasoningStartedAtMs: startedAtMs })}
            hasContent={false}
          />,
        );

        act(() => {
          vi.advanceTimersByTime(3000);
        });

        const spans = readLabelSpans();
        expect(spans.verbText).toBe('Thinking');
        expect(spans.suffixText?.trim()).toBe('for 3s');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should render "Thought briefly" for state=done with sub-second timing', () => {
      mockChatStatus.current = 'idle';
      render(
        <ChatMessageReasoning
          part={createReasoningPartWithTiming({
            state: 'done',
            reasoningStartedAtMs: 1_700_000_000_000,
            reasoningEndedAtMs: 1_700_000_000_500,
          })}
          hasContent={false}
        />,
      );

      const spans = readLabelSpans();
      expect(spans.verbText).toBe('Thought');
      expect(spans.suffixText?.trim()).toBe('briefly');
    });

    it('should render "Thought for 2s" for state=done with a 2-second elapsed timing', () => {
      mockChatStatus.current = 'idle';
      render(
        <ChatMessageReasoning
          part={createReasoningPartWithTiming({
            state: 'done',
            reasoningStartedAtMs: 1_700_000_000_000,
            reasoningEndedAtMs: 1_700_000_002_000,
          })}
          hasContent={false}
        />,
      );

      const spans = readLabelSpans();
      expect(spans.verbText).toBe('Thought');
      expect(spans.suffixText?.trim()).toBe('for 2s');
    });

    it('should render "Thought for 1m 12s" for state=done with a 72-second elapsed timing', () => {
      mockChatStatus.current = 'idle';
      render(
        <ChatMessageReasoning
          part={createReasoningPartWithTiming({
            state: 'done',
            reasoningStartedAtMs: 1_700_000_000_000,
            reasoningEndedAtMs: 1_700_000_072_000,
          })}
          hasContent={false}
        />,
      );

      const spans = readLabelSpans();
      expect(spans.verbText).toBe('Thought');
      expect(spans.suffixText?.trim()).toBe('for 1m 12s');
    });

    it('should render the verb in the foreground tone and the suffix in the muted tone', () => {
      mockChatStatus.current = 'idle';
      render(
        <ChatMessageReasoning
          part={createReasoningPartWithTiming({
            state: 'done',
            reasoningStartedAtMs: 1_700_000_000_000,
            reasoningEndedAtMs: 1_700_000_002_000,
          })}
          hasContent={false}
        />,
      );

      const spans = readLabelSpans();
      expect(spans.verbSpan.className).not.toContain(mutedClass);
      expect(spans.suffixSpan?.className).toContain(mutedClass);
    });

    it('should not render an empty muted suffix span for a single-word label like "Thinking…"', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));
        render(
          <ChatMessageReasoning
            part={createReasoningPartWithTiming({
              state: 'streaming',
              reasoningStartedAtMs: Date.now(),
            })}
            hasContent={false}
          />,
        );

        const spans = readLabelSpans();
        expect(spans.verbText).toBe('Thinking…');
        expect(spans.suffixSpan).toBeUndefined();
        const mutedSpans = spans.button.querySelectorAll(`span.${mutedClass.replace('/', String.raw`\/`)}`);
        expect(mutedSpans.length).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should anchor the live counter on the server-stamped time without client-arrival skew compensation', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-20T00:00:05Z'));
        const startedAtMs = Date.now() - 5000;

        render(
          <ChatMessageReasoning
            part={createReasoningPartWithTiming({ state: 'streaming', reasoningStartedAtMs: startedAtMs })}
            hasContent={false}
          />,
        );

        const spans = readLabelSpans();
        expect(spans.verbText).toBe('Thinking');
        expect(spans.suffixText?.trim()).toBe('for 5s');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
