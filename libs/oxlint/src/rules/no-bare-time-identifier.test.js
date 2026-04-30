import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { noBareTimeIdentifierRule } from './no-bare-time-identifier.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
  },
});

describe('no-bare-time-identifier', () => {
  it('flags bare time nouns at owned declaration sites and accepts prefixed names', () => {
    ruleTester.run('no-bare-time-identifier', noBareTimeIdentifierRule, {
      valid: [
        {
          name: 'prefixed const is allowed',
          code: 'const renderTimeout = 30_000;',
        },
        {
          name: 'prefixed type member is allowed',
          code: 'type Options = { refreshDebounce: number };',
        },
        {
          name: 'prefixed parameter is allowed',
          code: 'function schedule(retryDelay: number) { return retryDelay; }',
        },
        {
          name: 'object-literal key passing to external API is exempt (false-positive guard)',
          code: 'requestIdleCallback(() => {}, { timeout: 1000 });',
        },
        {
          name: 'object-literal key passing to vitest API is exempt',
          code: 'const cfg = { timeout: 30_000 };', // Demonstrates Property key (NOT a TSPropertySignature)
        },
        {
          name: 'duration is descriptive — not banned',
          code: 'const duration = 100;',
        },
        {
          name: 'elapsed is descriptive — not banned',
          code: 'function f(elapsed: number) { return elapsed; }',
        },
        {
          name: 'window is excluded (DOM global collision)',
          code: 'function makeCoalescer(window: number) { return window; }',
        },
        {
          name: 'arrow-function utility named after operation is exempt',
          code: 'const debounce = <T>(fn: (...a: T[]) => void, ms: number) => fn;',
        },
        {
          name: 'function-expression utility named after operation is exempt',
          code: 'const delay = function (ms: number) { return ms; };',
        },
        {
          name: 'function declaration named after operation is allowed (no Identifier.id check)',
          code: 'function throttle(ms: number) { return ms; }',
        },
      ],
      invalid: [
        {
          name: 'bare const debounce',
          code: 'const debounce = 500;',
          errors: [{ messageId: 'bareTime', data: { name: 'debounce', capitalised: 'Debounce' } }],
        },
        {
          name: 'bare class field debounce',
          code: 'class S { private readonly debounce: number = 0; }',
          errors: [{ messageId: 'bareTime', data: { name: 'debounce', capitalised: 'Debounce' } }],
        },
        {
          name: 'bare type-member timeout',
          code: 'type Options = { timeout?: number };',
          errors: [{ messageId: 'bareTime', data: { name: 'timeout', capitalised: 'Timeout' } }],
        },
        {
          name: 'bare interface-member ttl',
          code: 'interface Cache { ttl: number; }',
          errors: [{ messageId: 'bareTime', data: { name: 'ttl', capitalised: 'Ttl' } }],
        },
        {
          name: 'bare function parameter delay',
          code: 'function schedule(delay: number) { return delay; }',
          errors: [{ messageId: 'bareTime', data: { name: 'delay', capitalised: 'Delay' } }],
        },
        {
          name: 'bare arrow-function parameter interval',
          code: 'const f = (interval: number) => interval;',
          errors: [{ messageId: 'bareTime', data: { name: 'interval', capitalised: 'Interval' } }],
        },
        {
          name: 'bare nested type-literal property in another type',
          code: 'type Outer = { options: { debounce?: number } };',
          errors: [{ messageId: 'bareTime', data: { name: 'debounce', capitalised: 'Debounce' } }],
        },
      ],
    });
  });
});
