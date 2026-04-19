import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ActivationContext,
  LanguageContribution,
  ActivationResult,
  NavigationHandler,
} from '#lib/monaco-language-registry.js';
import { LanguageContributionRegistry } from '#lib/monaco-language-registry.js';

function createMockContext(): ActivationContext {
  // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- Minimal mock for testing
  return {} as ActivationContext;
}

function createMockContribution(
  languageId: string,
  overrides: Partial<LanguageContribution> = {},
): LanguageContribution {
  const handler: NavigationHandler = {
    canHandle: () => true,
  };

  return {
    languageId,
    register: vi.fn(),
    activate: vi.fn<() => ActivationResult>(() => ({
      disposables: [],
      navigationHandler: handler,
    })),
    dispose: vi.fn(),
    ...overrides,
  };
}

describe('LanguageContributionRegistry', () => {
  let registry: LanguageContributionRegistry;
  let context: ActivationContext;

  beforeEach(() => {
    registry = new LanguageContributionRegistry();
    context = createMockContext();
  });

  describe('activate', () => {
    it('should activate all contributions and return navigation handlers', () => {
      const contribA = createMockContribution('lang-a');
      const contribB = createMockContribution('lang-b');

      registry.addContribution(contribA);
      registry.addContribution(contribB);

      const handlers = registry.activate(context);

      expect(contribA.activate).toHaveBeenCalledWith(context);
      expect(contribB.activate).toHaveBeenCalledWith(context);
      expect(handlers).toHaveLength(2);
    });

    it('should not prevent other contributions from activating when one throws', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const contribA = createMockContribution('lang-a');
      const contribBroken = createMockContribution('lang-broken', {
        activate: vi.fn(() => {
          throw new Error('Activation failed');
        }),
      });
      const contribC = createMockContribution('lang-c');

      registry.addContribution(contribA);
      registry.addContribution(contribBroken);
      registry.addContribution(contribC);

      const handlers = registry.activate(context);

      // Both non-broken contributions should have activated
      expect(contribA.activate).toHaveBeenCalledWith(context);
      expect(contribBroken.activate).toHaveBeenCalled();
      expect(contribC.activate).toHaveBeenCalledWith(context);

      // Only 2 handlers (from A and C), broken contribution is skipped
      expect(handlers).toHaveLength(2);

      // Error should be logged with the failing contribution's languageId
      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to activate language contribution "lang-broken":',
        expect.any(Error),
      );

      errorSpy.mockRestore();
    });

    it('should commit epoch after all contributions process, not before', () => {
      const activationOrder: string[] = [];

      const contribA = createMockContribution('lang-a', {
        activate: vi.fn(() => {
          activationOrder.push('a');
          return { disposables: [] };
        }),
      });
      const contribB = createMockContribution('lang-b', {
        activate: vi.fn(() => {
          activationOrder.push('b');
          return { disposables: [] };
        }),
      });

      registry.addContribution(contribA);
      registry.addContribution(contribB);

      registry.activate(context);

      // Both contributions should have been processed
      expect(activationOrder).toEqual(['a', 'b']);

      // Calling activate again with same epoch should return cached handlers
      const cachedHandlers = registry.activate(context);
      expect(cachedHandlers).toEqual([]);
      // `activate` should not be called again
      expect(contribA.activate).toHaveBeenCalledTimes(1);
      expect(contribB.activate).toHaveBeenCalledTimes(1);
    });

    it('should return cached handlers on subsequent activate() calls with same epoch after a throw', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const contribA = createMockContribution('lang-a');
      const contribBroken = createMockContribution('lang-broken', {
        activate: vi.fn(() => {
          throw new Error('boom');
        }),
      });

      registry.addContribution(contribA);
      registry.addContribution(contribBroken);

      const firstResult = registry.activate(context);

      // Should have 1 handler from contribA (contribBroken threw)
      expect(firstResult).toHaveLength(1);

      // Second call with same epoch should return the same cached handlers
      const secondResult = registry.activate(context);
      expect(secondResult).toBe(firstResult);

      // `activate` should only have been called once for each contribution
      expect(contribA.activate).toHaveBeenCalledTimes(1);
      expect(contribBroken.activate).toHaveBeenCalledTimes(1);

      errorSpy.mockRestore();
    });

    it('should re-activate after project session change even if previous activation had errors', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      let shouldThrow = true;
      const contribFlaky = createMockContribution('lang-flaky', {
        activate: vi.fn(() => {
          if (shouldThrow) {
            throw new Error('temporary failure');
          }

          return {
            disposables: [],
            navigationHandler: { canHandle: () => true },
          };
        }),
      });
      const contribStable = createMockContribution('lang-stable');

      registry.addContribution(contribFlaky);
      registry.addContribution(contribStable);

      // First activation: flaky throws
      const firstResult = registry.activate(context);
      expect(firstResult).toHaveLength(1); // Only stable's handler

      // Project session change increments epoch
      shouldThrow = false;
      registry.onProjectSessionChange('project-2');

      // Second activation: flaky now succeeds
      const secondResult = registry.activate(context);
      expect(secondResult).toHaveLength(2); // Both handlers

      errorSpy.mockRestore();
    });
  });
});
