import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { noAsyncIifeRule } from './no-async-iife.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },
});

describe('no-async-iife', () => {
  it('flags void-fired async IIFEs and void-fired promise chains; allows escape hatch + legitimate awaits', () => {
    ruleTester.run('no-async-iife', noAsyncIifeRule, {
      valid: [
        {
          name: 'awaited async IIFE is legitimate',
          code: 'async function f() { await (async () => { return 1; })(); }',
        },
        {
          name: 'returned async IIFE is legitimate',
          code: 'function f() { return (async () => 1)(); }',
        },
        {
          name: 'void on a synchronous expression is unrelated',
          code: 'void 0;',
        },
        {
          name: 'void on a sync IIFE is unrelated (only async hides settlement)',
          code: 'void (() => 1)();',
        },
        {
          name: 'plain promise chain (no `void` prefix) is unrelated',
          code: 'doStuff().then(handler).catch(onError);',
        },
        {
          name: 'top-level worker bootstrap with escape-hatch comment is allowed',
          code: [
            '// async-iife: bootstrap — top-level worker init must defer Web Worker',
            '// resolution to runtime; see kernel-runtime-worker.ts.',
            'void (async () => { await Promise.resolve(); })();',
          ].join('\n'),
        },
        {
          name: 'escape hatch suppresses void p.then(...) too',
          code: ['// async-iife: bootstrap', 'void Promise.resolve(1).then((value) => value);'].join('\n'),
        },
      ],
      invalid: [
        {
          name: 'flags bare void async IIFE',
          code: 'void (async () => { await Promise.resolve(); })();',
          errors: [{ messageId: 'voidAsyncIife' }],
        },
        {
          name: 'flags void async function-expression IIFE',
          code: 'void (async function () { await Promise.resolve(); })();',
          errors: [{ messageId: 'voidAsyncIife' }],
        },
        {
          name: 'flags void promise.then(...)',
          code: 'void Promise.resolve(1).then((value) => value);',
          errors: [{ messageId: 'voidThenChain' }],
        },
        {
          name: 'flags void promise.catch(...)',
          code: 'void Promise.reject(new Error("x")).catch((error) => error);',
          errors: [{ messageId: 'voidThenChain' }],
        },
        {
          name: 'flags void promise.finally(...)',
          code: 'void Promise.resolve(1).finally(() => undefined);',
          errors: [{ messageId: 'voidThenChain' }],
        },
        {
          name: 'comment without escape-hatch tag does NOT suppress',
          code: [
            '// just a regular note about the async work below',
            'void (async () => { await Promise.resolve(); })();',
          ].join('\n'),
          errors: [{ messageId: 'voidAsyncIife' }],
        },
      ],
    });
  });
});
