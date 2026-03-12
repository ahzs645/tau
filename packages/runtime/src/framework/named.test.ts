import { describe, it, expect } from 'vitest';
import { named, preserveMethodNames } from '#framework/named.js';

describe('named', () => {
  it('should set the name of an anonymous function expression', () => {
    const handler = named('myHandler', function () {
      return 42;
    });
    expect(handler.name).toBe('myHandler');
    expect(handler()).toBe(42);
  });

  it('should set the name of an arrow function', () => {
    const handler = named('arrowHandler', () => 'result');
    expect(handler.name).toBe('arrowHandler');
    expect(handler()).toBe('result');
  });

  it('should set the name of an async function expression', async () => {
    const handler = named('asyncHandler', async function () {
      return 'async-result';
    });
    expect(handler.name).toBe('asyncHandler');
    await expect(handler()).resolves.toBe('async-result');
  });

  it('should override an existing function name', () => {
    function originalName() {
      return true;
    }
    const result = named('overriddenName', originalName);
    expect(result.name).toBe('overriddenName');
    expect(result).toBe(originalName);
  });

  it('should return the same function reference', () => {
    const original = named('noop', () => undefined);
    const result = named('test', original);
    expect(result).toBe(original);
  });

  it('should produce the annotated name in stack traces', () => {
    const thrower = named('namedThrower', () => {
      throw new Error('test');
    });

    try {
      thrower();
    } catch (error) {
      expect((error as Error).stack).toContain('namedThrower');
    }
  });

  it('should not throw for frozen functions with non-configurable name', () => {
    const frozen = named('initial', () => undefined);
    Object.defineProperty(frozen, 'name', { value: 'locked', configurable: false });
    expect(() => named('newName', frozen)).not.toThrow();
    expect(frozen.name).toBe('locked');
  });
});

describe('preserveMethodNames', () => {
  it('should set name on prototype methods', () => {
    class TestClass {
      public async render(): Promise<string> {
        return 'rendered';
      }

      public createGeometry(): number {
        return 42;
      }
    }

    preserveMethodNames(TestClass, ['render', 'createGeometry']);

    expect(TestClass.prototype.render.name).toBe('render');
    expect(TestClass.prototype.createGeometry.name).toBe('createGeometry');
  });

  it('should restore mangled method names', () => {
    class Worker {
      public async compute(): Promise<void> {
        /* Stub for testing name preservation */
      }
    }

    Object.defineProperty(Worker.prototype.compute, 'name', { value: 'a', configurable: true });
    expect(Worker.prototype.compute.name).toBe('a');

    preserveMethodNames(Worker, ['compute']);
    expect(Worker.prototype.compute.name).toBe('compute');
  });

  it('should handle abstract classes via subclass', () => {
    abstract class Base {
      public async process(): Promise<void> {
        /* Stub for testing name preservation */
      }
      public abstract run(): void;
    }

    class Concrete extends Base {
      public run(): void {
        /* Stub for testing name preservation */
      }
    }

    preserveMethodNames(Concrete, ['run', 'process']);
    expect(Concrete.prototype.run.name).toBe('run');
  });

  it('should skip non-function prototype properties without error', () => {
    class WithData {
      public value = 42;
      public method(): void {
        /* Stub for testing name preservation */
      }
    }

    expect(() => {
      preserveMethodNames(WithData, ['method']);
    }).not.toThrow();
  });
});
