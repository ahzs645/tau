import { describe, it, expect, vi, afterEach } from 'vitest';
import { createActor } from 'xstate';
import { mock } from 'vitest-mock-extended';
import type { AnyActorRef } from 'xstate';
import { cameraCapabilityMachine } from '#machines/camera-capability.machine.js';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function createMockGraphicsRef() {
  return mock<AnyActorRef>({ send: vi.fn() });
}

function createTestActor(graphicsRef?: AnyActorRef) {
  return createActor(cameraCapabilityMachine, {
    input: { graphicsRef: graphicsRef ?? createMockGraphicsRef() },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cameraCapabilityMachine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('should start in unregistered state', () => {
      const actor = createTestActor();
      actor.start();
      expect(actor.getSnapshot().value).toBe('unregistered');
      actor.stop();
    });

    it('should store graphicsRef from input', () => {
      const graphicsRef = createMockGraphicsRef();
      const actor = createTestActor(graphicsRef);
      actor.start();
      expect(actor.getSnapshot().context.graphicsRef).toBe(graphicsRef);
      actor.stop();
    });
  });

  describe('registration', () => {
    it('should transition to registered on registerReset', () => {
      const actor = createTestActor();
      actor.start();
      const resetFunction = vi.fn();
      actor.send({ type: 'registerReset', reset: resetFunction });
      expect(actor.getSnapshot().value).toBe('registered');
      actor.stop();
    });

    it('should store reset function in context on registration', () => {
      const actor = createTestActor();
      actor.start();
      const resetFunction = vi.fn();
      actor.send({ type: 'registerReset', reset: resetFunction });
      expect(actor.getSnapshot().context.resetFunction).toBe(resetFunction);
      actor.stop();
    });

    it('should allow re-registration in registered state', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'registerReset', reset: vi.fn() });
      expect(actor.getSnapshot().value).toBe('registered');

      const newResetFunction = vi.fn();
      actor.send({ type: 'registerReset', reset: newResetFunction });
      expect(actor.getSnapshot().value).toBe('registered');
      expect(actor.getSnapshot().context.resetFunction).toBe(newResetFunction);
      actor.stop();
    });
  });

  describe('camera reset', () => {
    it('should call the registered reset function and return to registered', () => {
      const resetFunction = vi.fn();
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'registerReset', reset: resetFunction });
      actor.send({ type: 'reset' });

      expect(actor.getSnapshot().value).toBe('registered');
      expect(resetFunction).toHaveBeenCalledOnce();
      actor.stop();
    });

    it('should pass options to the reset function', () => {
      const resetFunction = vi.fn();
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'registerReset', reset: resetFunction });
      actor.send({ type: 'reset', options: { enableConfiguredAngles: true } });

      expect(resetFunction).toHaveBeenCalledWith({ enableConfiguredAngles: true });
      actor.stop();
    });

    it('should return to registered and log error after failed reset', () => {
      const resetFunction = vi.fn(() => {
        throw new Error('camera reset failed');
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'registerReset', reset: resetFunction });
      actor.send({ type: 'reset' });

      expect(actor.getSnapshot().value).toBe('registered');
      expect(consoleSpy).toHaveBeenCalledWith(
        'Camera reset failed:',
        expect.objectContaining({ message: 'camera reset failed' }),
      );
      actor.stop();
    });
  });

  describe('ignored events', () => {
    it('should ignore reset in unregistered state', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'reset' });
      expect(actor.getSnapshot().value).toBe('unregistered');
      actor.stop();
    });
  });
});
