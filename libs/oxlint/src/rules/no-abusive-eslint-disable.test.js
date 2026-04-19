import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import { noAbusiveEslintDisableRule } from './no-abusive-eslint-disable.js';

const ruleTester = new RuleTester();

describe('no-abusive-eslint-disable', () => {
  it('should report blanket disables and accept targeted ones', () => {
    ruleTester.run('no-abusive-eslint-disable', noAbusiveEslintDisableRule, {
      valid: [
        {
          name: 'line comment with rule name',
          code: '// oxlint-disable-next-line no-console\nconsole.log("ok");',
        },
        {
          name: 'line comment with scoped rule name',
          code: '// oxlint-disable-next-line @typescript-eslint/no-unused-vars\nconst x = 1;',
        },
        {
          name: 'block comment with rule name',
          code: '/* oxlint-disable no-console */\nconsole.log("ok");',
        },
        {
          name: 'oxlint-disable-line with rule name',
          code: 'console.log("ok"); // oxlint-disable-line no-console',
        },
        {
          name: 'rule name with description after --',
          code: '// oxlint-disable-next-line no-console -- debugging output\nconsole.log("ok");',
        },
        {
          name: 'normal comment without disable directive',
          code: '// This is a normal comment\nconst x = 1;',
        },
        {
          name: 'multiple rules specified',
          code: '// oxlint-disable-next-line no-console, no-debugger\nconsole.log("ok");',
        },
      ],
      invalid: [
        {
          name: 'blanket oxlint-disable-next-line',
          code: '// oxlint-disable-next-line\nconsole.log("bad");',
          errors: [{ messageId: 'abusive' }],
        },
        {
          name: 'blanket oxlint-disable block comment',
          code: '/* oxlint-disable */\nconsole.log("bad");',
          errors: [{ messageId: 'abusive' }],
        },
        {
          name: 'blanket oxlint-disable-line',
          code: 'console.log("bad"); // oxlint-disable-line',
          errors: [{ messageId: 'abusive' }],
        },
        {
          name: 'blanket disable with only a description (no rules)',
          code: '// oxlint-disable-next-line -- some reason\nconsole.log("bad");',
          errors: [{ messageId: 'abusive' }],
        },
        {
          name: 'blanket oxlint-disable without any content',
          code: '// oxlint-disable\nconst x = 1;',
          errors: [{ messageId: 'abusive' }],
        },
      ],
    });
  });

  it('should handle multiline block comments with mixed directives', () => {
    ruleTester.run('no-abusive-eslint-disable', noAbusiveEslintDisableRule, {
      valid: [
        {
          name: 'multiline block with all targeted disables',
          code: '/*\n * oxlint-disable-next-line no-console\n */\nconsole.log("ok");',
        },
      ],
      invalid: [
        {
          name: 'multiline block with blanket disable reports once',
          code: '/*\n * oxlint-disable\n */\nconst x = 1;',
          errors: [{ messageId: 'abusive' }],
        },
      ],
    });
  });
});
