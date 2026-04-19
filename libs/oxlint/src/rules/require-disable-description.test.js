import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import { requireDisableDescriptionRule } from './require-disable-description.js';

const ruleTester = new RuleTester();

describe('require-disable-description', () => {
  it('should report missing descriptions and accept described disables', () => {
    ruleTester.run('require-disable-description', requireDisableDescriptionRule, {
      valid: [
        {
          name: 'disable with description after --',
          code: '// oxlint-disable-next-line no-console -- debugging output\nconsole.log("ok");',
        },
        {
          name: 'oxlint-disable-line with description',
          code: 'console.log("ok"); // oxlint-disable-line no-console -- needed for logging',
        },
        {
          name: 'block comment disable with description',
          code: '/* oxlint-disable no-console -- globally needed */\nconsole.log("ok");',
        },
        {
          name: 'blanket disable without rules is ignored by this rule',
          code: '// oxlint-disable-next-line\nconsole.log("ok");',
        },
        {
          name: 'normal comment without directive',
          code: '// This is a normal comment\nconst x = 1;',
        },
        {
          name: 'description with double hyphens inside',
          code: '// oxlint-disable-next-line no-console -- debugging -- extra info\nconsole.log("ok");',
        },
      ],
      invalid: [
        {
          name: 'oxlint-disable-next-line without description',
          code: '// oxlint-disable-next-line no-console\nconsole.log("bad");',
          errors: [{ messageId: 'missingDescription', data: { rules: 'no-console' } }],
        },
        {
          name: 'oxlint-disable-line without description',
          code: 'console.log("bad"); // oxlint-disable-line no-console',
          errors: [{ messageId: 'missingDescription', data: { rules: 'no-console' } }],
        },
        {
          name: 'block comment disable without description',
          code: '/* oxlint-disable no-console */\nconsole.log("bad");',
          errors: [{ messageId: 'missingDescription', data: { rules: 'no-console' } }],
        },
        {
          name: 'multiple rules without description',
          code: '// oxlint-disable-next-line no-console, no-debugger\nconsole.log("bad");',
          errors: [{ messageId: 'missingDescription', data: { rules: 'no-console, no-debugger' } }],
        },
        {
          name: 'scoped rule without description',
          code: '// oxlint-disable-next-line @typescript-eslint/no-unused-vars\nconst x = 1;',
          errors: [{ messageId: 'missingDescription', data: { rules: '@typescript-eslint/no-unused-vars' } }],
        },
        {
          name: 'disable with empty description after --',
          code: '// oxlint-disable-next-line no-console --\nconsole.log("bad");',
          errors: [{ messageId: 'missingDescription', data: { rules: 'no-console' } }],
        },
        {
          name: 'disable with only whitespace after --',
          code: '// oxlint-disable-next-line no-console --   \nconsole.log("bad");',
          errors: [{ messageId: 'missingDescription', data: { rules: 'no-console' } }],
        },
      ],
    });
  });

  it('should handle blanket disable with trailing whitespace gracefully', () => {
    ruleTester.run('require-disable-description', requireDisableDescriptionRule, {
      valid: [
        {
          name: 'blanket disable with trailing spaces has no rules so is skipped',
          code: '// oxlint-disable   \nconst x = 1;',
        },
      ],
      invalid: [],
    });
  });

  it('should handle multiline block comment with directive', () => {
    ruleTester.run('require-disable-description', requireDisableDescriptionRule, {
      valid: [
        {
          name: 'multiline block with described disable',
          code: '/*\n * oxlint-disable-next-line no-console -- needed\n */\nconsole.log("ok");',
        },
      ],
      invalid: [
        {
          name: 'multiline block with undescribed disable',
          code: '/*\n * oxlint-disable-next-line no-console\n */\nconsole.log("bad");',
          errors: [{ messageId: 'missingDescription', data: { rules: 'no-console' } }],
        },
      ],
    });
  });
});
