import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { noLiteralConstAssertionRule } from './no-literal-const-assertion.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
  },
});

describe('no-literal-const-assertion', () => {
  it('should report as const on literals and accept on non-literals', () => {
    ruleTester.run('no-literal-const-assertion', noLiteralConstAssertionRule, {
      valid: [
        {
          name: 'object as const is allowed',
          code: 'const x = { foo: "bar" } as const;',
        },
        {
          name: 'array as const is allowed',
          code: 'const x = ["a", "b"] as const;',
        },
        {
          name: 'plain string literal without as const',
          code: 'const x = "foo";',
        },
        {
          name: 'number literal without as const',
          code: 'const x = 42;',
        },
        {
          name: 'type assertion to a specific type (not const)',
          code: 'const x = "foo" as string;',
        },
        {
          name: 'template literal is not a Literal node',
          code: 'const x = `hello` as const;',
        },
        {
          name: 'undefined is an Identifier, not a Literal',
          code: 'const x = undefined as const;',
        },
        {
          name: 'negative number is UnaryExpression, not Literal',
          code: 'const x = -1 as const;',
        },
      ],
      invalid: [
        {
          name: 'string literal as const',
          code: 'const x = "foo" as const;',
          output: 'const x = "foo";',
          errors: [{ messageId: 'unnecessary' }],
        },
        {
          name: 'number literal as const',
          code: 'const x = 42 as const;',
          output: 'const x = 42;',
          errors: [{ messageId: 'unnecessary' }],
        },
        {
          name: 'boolean true as const',
          code: 'const x = true as const;',
          output: 'const x = true;',
          errors: [{ messageId: 'unnecessary' }],
        },
        {
          name: 'boolean false as const',
          code: 'const x = false as const;',
          output: 'const x = false;',
          errors: [{ messageId: 'unnecessary' }],
        },
        {
          name: 'null as const',
          code: 'const x = null as const;',
          output: 'const x = null;',
          errors: [{ messageId: 'unnecessary' }],
        },
        {
          name: 'bigint literal as const',
          code: 'const x = 0n as const;',
          output: 'const x = 0n;',
          errors: [{ messageId: 'unnecessary' }],
        },
      ],
    });
  });
});
