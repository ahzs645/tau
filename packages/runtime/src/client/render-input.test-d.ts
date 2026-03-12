/* eslint-disable @typescript-eslint/naming-convention -- file format names don't follow camelCase */
/**
 * Type-level tests for `CodeInput<T>` and `FileInput` render input types.
 *
 * Verifies compile-time mutual exclusion constraints and the generic
 * `file` requirement based on code object key count.
 *
 * These tests are statically analysed by the TypeScript compiler via
 * vitest --typecheck and are never executed at runtime.
 *
 * `void` is used to suppress the compiler's warning about unused variables.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { GeometryFile } from '@taucad/types';
import type { CodeInput, ExportResult, FileInput, KernelClient } from '#client/kernel-client.js';
import type { Tessellation } from '#types/kernel-worker.types.js';

// =============================================================================
// CodeInput<T> -- single-key inline mode
// =============================================================================

describe('CodeInput single-key (file optional)', () => {
  it('should compile with single-key code object', () => {
    const input: CodeInput<{ 'box.ts': string }> = {
      code: { 'box.ts': 'const x = 1;' },
    };
    expectTypeOf(input.code).toEqualTypeOf<{ 'box.ts': string }>();
  });

  it('should compile with single-key code and explicit file', () => {
    expectTypeOf<CodeInput<{ 'box.ts': string }>>().toMatchObjectType<{
      code: { 'box.ts': string };
      file?: string;
    }>();
  });

  it('should compile with single-key code and parameters', () => {
    expectTypeOf<CodeInput<{ 'box.ts': string }>>().toExtend<{
      code: { 'box.ts': string };
      parameters?: Record<string, unknown>;
    }>();
  });

  it('should compile with non-JS/TS extension', () => {
    const input: CodeInput<{ 'model.kcl': string }> = {
      code: { 'model.kcl': 'fn main() {}' },
    };
    expectTypeOf(input.code).toEqualTypeOf<{ 'model.kcl': string }>();
  });

  it('should NOT allow GeometryFile as file in code mode', () => {
    const geo: GeometryFile = { path: '/', filename: 'box.ts' };

    const input: CodeInput<{ 'box.ts': string }> = {
      code: { 'box.ts': 'const x = 1;' },
      // @ts-expect-error -- GeometryFile is not assignable to string (code mode)
      file: geo,
    };
    void input;
  });
});

// =============================================================================
// CodeInput<T> -- multi-key inline mode
// =============================================================================

describe('CodeInput multi-key (file required)', () => {
  it('should compile with multi-key code and required file', () => {
    const input: CodeInput<{ 'main.ts': string; 'utils.ts': string }> = {
      code: {
        'main.ts': 'import "./utils"',
        'utils.ts': 'export const x = 1;',
      },
      file: 'main.ts',
    };
    expectTypeOf(input.file).toBeString();
  });

  it('should compile with multi-key code, file, and parameters', () => {
    const input: CodeInput<{ 'main.ts': string; 'utils.ts': string }> = {
      code: {
        'main.ts': 'import "./utils"',
        'utils.ts': 'export const x = 1;',
      },
      file: 'main.ts',
      parameters: { width: 50 },
    };
    expectTypeOf(input.parameters).toEqualTypeOf<Record<string, unknown> | undefined>();
  });

  it('should NOT compile without file for multi-key code', () => {
    // @ts-expect-error -- file is required when code has multiple keys
    const input: CodeInput<{ 'main.ts': string; 'utils.ts': string }> = {
      code: {
        'main.ts': 'import "./utils"',
        'utils.ts': 'export const x = 1;',
      },
    };
    void input;
  });

  it('should NOT allow GeometryFile as file in multi-key code mode', () => {
    const geo: GeometryFile = { path: '/', filename: 'main.ts' };

    const input: CodeInput<{ 'main.ts': string; 'utils.ts': string }> = {
      code: {
        'main.ts': 'import "./utils"',
        'utils.ts': 'export const x = 1;',
      },
      // @ts-expect-error -- GeometryFile is not assignable to string (code mode)
      file: geo,
    };
    void input;
  });
});

// =============================================================================
// CodeInput<T> -- dynamic Record<string, string>
// =============================================================================

describe('CodeInput dynamic Record (file required)', () => {
  it('should compile with dynamic Record and explicit file', () => {
    const dynamicFiles: Record<string, string> = { 'main.ts': 'const x = 1;' };
    const input: CodeInput<Record<string, string>> = {
      code: dynamicFiles,
      file: 'main.ts',
    };
    expectTypeOf(input.file).toBeString();
  });

  it('should NOT compile with dynamic Record without file', () => {
    const dynamicFiles: Record<string, string> = { 'main.ts': 'const x = 1;' };

    // @ts-expect-error -- file is required for wide Record<string, string>
    const input: CodeInput<Record<string, string>> = {
      code: dynamicFiles,
    };
    void input;
  });
});

// =============================================================================
// FileInput -- filesystem mode
// =============================================================================

describe('FileInput (filesystem mode)', () => {
  it('should compile with string file', () => {
    expectTypeOf<FileInput>().toExtend<{ file: string | GeometryFile }>();
  });

  it('should compile with GeometryFile', () => {
    const input: FileInput = {
      file: { path: '/builds/test', filename: 'box.ts' },
    };
    expectTypeOf(input.file).toEqualTypeOf<string | GeometryFile>();
  });

  it('should compile with parameters and tessellation', () => {
    expectTypeOf<FileInput>().toExtend<{
      file: string | GeometryFile;
      parameters?: Record<string, unknown>;
    }>();
  });

  it('should NOT allow code in file mode', () => {
    expectTypeOf<FileInput['code']>().toEqualTypeOf<undefined>();
  });
});

// =============================================================================
// KernelClient.render() overload resolution
// =============================================================================

describe('KernelClient.render() overload resolution', () => {
  // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- pure type testing
  const client = {} as KernelClient;

  it('should accept single-key code (file inferred)', () => {
    expectTypeOf(client.render({ code: { 'box.ts': 'const x = 1;' } })).toBeObject();
  });

  it('should accept multi-key code with file', () => {
    expectTypeOf(
      client.render({
        code: {
          'main.ts': 'import "./utils"',
          'utils.ts': 'export const x = 1;',
        },
        file: 'main.ts',
      }),
    ).toBeObject();
  });

  it('should accept filesystem string shorthand', () => {
    expectTypeOf(client.render({ file: '/src/main.ts' })).toBeObject();
  });

  it('should accept filesystem GeometryFile', () => {
    expectTypeOf(client.render({ file: { path: '/', filename: 'main.ts' } })).toBeObject();
  });

  it('should reject multi-key code without file', () => {
    // @ts-expect-error -- file is required for multi-key code
    void client.render({ code: { 'main.ts': '...', 'utils.ts': '...' } });
  });

  it('should reject empty object', () => {
    // @ts-expect-error -- neither code nor file provided
    void client.render({});
  });

  it('should reject only parameters', () => {
    // @ts-expect-error -- missing code or file
    void client.render({ parameters: { width: 50 } });
  });
});

// =============================================================================
// KernelClient.export() overload resolution
// =============================================================================

describe('KernelClient.export() overload resolution', () => {
  // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- pure type testing
  const client: KernelClient = {} as KernelClient;

  it('should accept format-only (export from last render)', () => {
    expectTypeOf(client.export('step')).toEqualTypeOf<Promise<ExportResult>>();
  });

  it('should accept format with tessellation options', () => {
    const tessellation: Tessellation = {
      linearTolerance: 0.1,
      angularTolerance: 30,
    };
    expectTypeOf(client.export('step', { tessellation })).toEqualTypeOf<Promise<ExportResult>>();
  });

  it('should accept self-rendering with single-file inline code', () => {
    expectTypeOf(client.export('step', { code: { 'box.ts': 'const x = 1;' } })).toEqualTypeOf<Promise<ExportResult>>();
  });

  it('should accept self-rendering with multi-file inline code', () => {
    expectTypeOf(
      client.export('step', {
        code: { 'main.ts': 'import "./lib"', 'lib.ts': 'export const x = 1;' },
        file: 'main.ts',
      }),
    ).toEqualTypeOf<Promise<ExportResult>>();
  });

  it('should accept self-rendering with filesystem file', () => {
    expectTypeOf(client.export('step', { file: '/src/main.ts' })).toEqualTypeOf<Promise<ExportResult>>();
  });

  it('should accept self-rendering with GeometryFile', () => {
    expectTypeOf(
      client.export('step', {
        file: { path: '/', filename: 'main.ts' },
      }),
    ).toEqualTypeOf<Promise<ExportResult>>();
  });
});
