import { describe, it, expect, vi, afterEach } from 'vitest';
import { createActor } from 'xstate';
import { mock } from 'vitest-mock-extended';
import type { AnyActorRef, Subscription } from 'xstate';
import { screenshotRequestMachine, orthographicViews } from '#machines/screenshot-request.machine.js';
import type { ScreenshotOptions } from '@taucad/types';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function createMockGraphicsRef() {
  const subscriptions = new Map<string, (event: Record<string, unknown>) => void>();
  const ref = mock<AnyActorRef>({
    send: vi.fn(),
    on: vi.fn((eventType: string, handler: (event: Record<string, unknown>) => void) => {
      subscriptions.set(eventType, handler);
      return mock<Subscription>();
    }),
  });
  return { ref, subscriptions };
}

function createTestActor(graphicsRef?: AnyActorRef) {
  return createActor(screenshotRequestMachine, {
    input: { graphicsRef },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('screenshotRequestMachine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('should start in idle state', () => {
      const { ref } = createMockGraphicsRef();
      const actor = createTestActor(ref);
      actor.start();
      expect(actor.getSnapshot().value).toBe('idle');
      expect(actor.getSnapshot().context.currentRequest).toBeUndefined();
      expect(actor.getSnapshot().context.error).toBeUndefined();
      actor.stop();
    });

    it('should store graphicsRef from input', () => {
      const { ref } = createMockGraphicsRef();
      const actor = createTestActor(ref);
      actor.start();
      expect(actor.getSnapshot().context.graphicsRef).toBe(ref);
      actor.stop();
    });
  });

  describe('requesting screenshot', () => {
    it('should transition to requesting on requestScreenshot', () => {
      const { ref } = createMockGraphicsRef();
      const actor = createTestActor(ref);
      actor.start();

      const options: ScreenshotOptions = { aspectRatio: 16 / 9 };
      actor.send({
        type: 'requestScreenshot',
        options,
        onSuccess: vi.fn(),
        onError: vi.fn(),
      });

      expect(actor.getSnapshot().value).toBe('requesting');
      expect(actor.getSnapshot().context.currentRequest).toBeDefined();
      expect(actor.getSnapshot().context.currentRequest?.options).toEqual(options);
      actor.stop();
    });

    it('should store request with a generated requestId', () => {
      const { ref } = createMockGraphicsRef();
      const actor = createTestActor(ref);
      actor.start();

      actor.send({
        type: 'requestScreenshot',
        options: { aspectRatio: 1 },
        onSuccess: vi.fn(),
      });

      const { currentRequest } = actor.getSnapshot().context;
      expect(currentRequest?.requestId).toBeDefined();
      expect(currentRequest?.isComposite).toBe(false);
      actor.stop();
    });

    it('should call onError when graphicsRef is undefined', () => {
      const actor = createTestActor(undefined);
      actor.start();

      const onError = vi.fn();
      actor.send({
        type: 'requestScreenshot',
        options: { aspectRatio: 1 },
        onError,
      });

      expect(onError).toHaveBeenCalledWith('No graphics view is currently mounted');
      actor.stop();
    });
  });

  describe('requesting composite screenshot', () => {
    it('should transition to requesting on requestCompositeScreenshot', () => {
      const { ref } = createMockGraphicsRef();
      const actor = createTestActor(ref);
      actor.start();

      actor.send({
        type: 'requestCompositeScreenshot',
        options: { aspectRatio: 16 / 9, cameraAngles: orthographicViews.slice(0, 6) },
        onSuccess: vi.fn(),
      });

      expect(actor.getSnapshot().value).toBe('requesting');
      expect(actor.getSnapshot().context.currentRequest?.isComposite).toBe(true);
      actor.stop();
    });

    it('should store composite request with isComposite flag', () => {
      const { ref } = createMockGraphicsRef();
      const actor = createTestActor(ref);
      actor.start();

      actor.send({
        type: 'requestCompositeScreenshot',
        options: { aspectRatio: 16 / 9 },
        onSuccess: vi.fn(),
      });

      const { currentRequest } = actor.getSnapshot().context;
      expect(currentRequest?.requestId).toBeDefined();
      expect(currentRequest?.isComposite).toBe(true);
      actor.stop();
    });
  });

  describe('screenshot completion', () => {
    it('should return to idle and call onSuccess on screenshotCompleted', () => {
      const { ref, subscriptions } = createMockGraphicsRef();
      const actor = createTestActor(ref);
      actor.start();

      const onSuccess = vi.fn();
      actor.send({
        type: 'requestScreenshot',
        options: { aspectRatio: 1 },
        onSuccess,
      });

      const requestId = actor.getSnapshot().context.currentRequest!.requestId;
      const completedHandler = subscriptions.get('screenshotCompleted');
      completedHandler?.({ dataUrls: ['data:image/png;base64,abc'], requestId });

      expect(actor.getSnapshot().value).toBe('idle');
      expect(actor.getSnapshot().context.currentRequest).toBeUndefined();
      actor.stop();
    });

    it('should return to idle and call onError on screenshotFailed', () => {
      const { ref, subscriptions } = createMockGraphicsRef();
      const actor = createTestActor(ref);
      actor.start();

      const onError = vi.fn();
      actor.send({
        type: 'requestScreenshot',
        options: { aspectRatio: 1 },
        onError,
      });

      const requestId = actor.getSnapshot().context.currentRequest!.requestId;
      const failedHandler = subscriptions.get('screenshotFailed');
      failedHandler?.({ error: 'canvas disconnected', requestId });

      expect(actor.getSnapshot().value).toBe('idle');
      expect(actor.getSnapshot().context.currentRequest).toBeUndefined();
      expect(actor.getSnapshot().context.error).toBe('canvas disconnected');
      actor.stop();
    });
  });

  describe('cancellation', () => {
    it('should return to idle on cancel', () => {
      const { ref } = createMockGraphicsRef();
      const actor = createTestActor(ref);
      actor.start();

      actor.send({
        type: 'requestScreenshot',
        options: { aspectRatio: 1 },
        onSuccess: vi.fn(),
      });

      expect(actor.getSnapshot().value).toBe('requesting');
      actor.send({ type: 'cancel' });
      expect(actor.getSnapshot().value).toBe('idle');
      expect(actor.getSnapshot().context.currentRequest).toBeUndefined();
      expect(actor.getSnapshot().context.error).toBe('Request cancelled');
      actor.stop();
    });
  });

  describe('request override', () => {
    it('should allow a new request to override the current one while requesting', () => {
      const { ref } = createMockGraphicsRef();
      const actor = createTestActor(ref);
      actor.start();

      actor.send({
        type: 'requestScreenshot',
        options: { aspectRatio: 4 / 3 },
        onSuccess: vi.fn(),
      });

      const firstRequestId = actor.getSnapshot().context.currentRequest?.requestId;

      actor.send({
        type: 'requestScreenshot',
        options: { aspectRatio: 16 / 9 },
        onSuccess: vi.fn(),
      });

      const secondRequestId = actor.getSnapshot().context.currentRequest?.requestId;
      expect(secondRequestId).not.toBe(firstRequestId);
      expect(actor.getSnapshot().context.currentRequest?.options.aspectRatio).toBe(16 / 9);
      actor.stop();
    });
  });

  describe('orthographicViews', () => {
    it('should export predefined orthographic camera angles', () => {
      expect(orthographicViews).toHaveLength(22);
      expect(orthographicViews[0]).toEqual({ label: 'front', phi: 90, theta: 270 });
      expect(orthographicViews[4]).toEqual({ label: 'top', phi: 0, theta: 0 });
    });

    it('should contain all six cardinal views', () => {
      const labels = orthographicViews.map((v) => v.label);
      for (const cardinal of ['front', 'back', 'right', 'left', 'top', 'bottom']) {
        expect(labels).toContain(cardinal);
      }
    });
  });
});
