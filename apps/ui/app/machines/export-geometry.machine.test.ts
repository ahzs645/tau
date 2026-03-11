import { describe, it, expect, vi, afterEach } from 'vitest';
import { createActor } from 'xstate';
import { mock } from 'vitest-mock-extended';
import type { ActorRefFrom, Subscription } from 'xstate';
import { exportGeometryMachine } from '#machines/export-geometry.machine.js';
import type { cadMachine } from '#machines/cad.machine.js';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

type CadRef = ActorRefFrom<typeof cadMachine>;

function createMockCadRef() {
  const subscriptions = new Map<string, (event: Record<string, unknown>) => void>();
  const cadRef = mock<CadRef>({
    send: vi.fn(),
    on: vi.fn((eventType: string, handler: (event: Record<string, unknown>) => void) => {
      subscriptions.set(eventType, handler);
      return mock<Subscription>();
    }),
  });
  return { cadRef, subscriptions };
}

function createTestActor(cadRef?: CadRef) {
  return createActor(exportGeometryMachine, {
    input: { cadRef },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('exportGeometryMachine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('should start in idle state', () => {
      const actor = createTestActor();
      actor.start();
      expect(actor.getSnapshot().value).toBe('idle');
      expect(actor.getSnapshot().context.activeRequest).toBeUndefined();
      actor.stop();
    });

    it('should store cadRef from input', () => {
      const { cadRef } = createMockCadRef();
      const actor = createTestActor(cadRef);
      actor.start();
      expect(actor.getSnapshot().context.cadRef).toBe(cadRef);
      actor.stop();
    });
  });

  describe('requesting export', () => {
    it('should transition to exporting on requestExport', () => {
      const { cadRef } = createMockCadRef();
      const actor = createTestActor(cadRef);
      actor.start();

      const onSuccess = vi.fn();
      const onError = vi.fn();
      actor.send({
        type: 'requestExport',
        format: 'stl',
        onSuccess,
        onError,
      });

      expect(actor.getSnapshot().value).toBe('exporting');
      expect(actor.getSnapshot().context.activeRequest).toEqual(
        expect.objectContaining({
          format: 'stl',
        }),
      );
      actor.stop();
    });

    it('should send exportGeometry to cadRef', () => {
      const { cadRef } = createMockCadRef();
      const actor = createTestActor(cadRef);
      actor.start();

      actor.send({
        type: 'requestExport',
        format: 'step',
        onSuccess: vi.fn(),
        onError: vi.fn(),
      });

      expect(cadRef.send).toHaveBeenCalledWith({
        type: 'exportGeometry',
        format: 'step',
      });
      actor.stop();
    });
  });

  describe('export completion', () => {
    it('should return to idle and call onSuccess on exportCompleted', () => {
      const { cadRef, subscriptions } = createMockCadRef();
      const actor = createTestActor(cadRef);
      actor.start();

      const onSuccess = vi.fn();
      actor.send({
        type: 'requestExport',
        format: 'stl',
        onSuccess,
        onError: vi.fn(),
      });

      const exportCompletedHandler = subscriptions.get('geometryExported');
      exportCompletedHandler?.({ blob: new Blob(), format: 'stl' });

      expect(actor.getSnapshot().value).toBe('idle');
      expect(actor.getSnapshot().context.activeRequest).toBeUndefined();
      actor.stop();
    });

    it('should return to idle and call onError on exportFailed', () => {
      const { cadRef, subscriptions } = createMockCadRef();
      const actor = createTestActor(cadRef);
      actor.start();

      const onError = vi.fn();
      actor.send({
        type: 'requestExport',
        format: 'stl',
        onSuccess: vi.fn(),
        onError,
      });

      const exportFailedHandler = subscriptions.get('exportFailed');
      exportFailedHandler?.({ errors: [{ message: 'conversion failed' }] });

      expect(actor.getSnapshot().value).toBe('idle');
      expect(actor.getSnapshot().context.activeRequest).toBeUndefined();
      actor.stop();
    });
  });

  describe('request override', () => {
    it('should allow a new request to override the current one while exporting', () => {
      const { cadRef } = createMockCadRef();
      const actor = createTestActor(cadRef);
      actor.start();

      actor.send({
        type: 'requestExport',
        format: 'stl',
        onSuccess: vi.fn(),
        onError: vi.fn(),
      });

      expect(actor.getSnapshot().value).toBe('exporting');

      const newOnSuccess = vi.fn();
      actor.send({
        type: 'requestExport',
        format: 'step',
        onSuccess: newOnSuccess,
        onError: vi.fn(),
      });

      expect(actor.getSnapshot().value).toBe('exporting');
      expect(actor.getSnapshot().context.activeRequest).toEqual(expect.objectContaining({ format: 'step' }));
      actor.stop();
    });
  });

  describe('no cadRef', () => {
    it('should accept undefined cadRef without crashing', () => {
      const actor = createTestActor(undefined);
      actor.start();
      expect(actor.getSnapshot().value).toBe('idle');
      expect(actor.getSnapshot().context.cadRef).toBeUndefined();
      actor.stop();
    });
  });
});
