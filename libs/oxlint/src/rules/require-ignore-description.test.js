import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import { requireIgnoreDescriptionRule } from './require-ignore-description.js';

const ruleTester = new RuleTester();

describe('require-ignore-description', () => {
  it('should report missing descriptions on ignore directives', () => {
    ruleTester.run('require-ignore-description', requireIgnoreDescriptionRule, {
      valid: [
        {
          name: 'prettier-ignore with description',
          code: '// prettier-ignore -- complex alignment',
        },
        {
          name: 'oxfmt-ignore with description',
          code: '// oxfmt-ignore -- intentional formatting',
        },
        {
          name: 'normal comment without ignore directive',
          code: '// This is a normal comment',
        },
        {
          name: 'comment mentioning prettier-ignore in prose',
          code: '// We use prettier-ignore for tables\nconst x = 1;',
        },
        {
          name: 'block comment with prettier-ignore and description',
          code: '/* prettier-ignore -- table alignment */\nconst x = 1;',
        },
      ],
      invalid: [
        {
          name: 'prettier-ignore without description',
          code: '// prettier-ignore\nconst x = 1;',
          errors: [{ messageId: 'missingDescription', data: { directive: 'prettier-ignore' } }],
        },
        {
          name: 'oxfmt-ignore without description',
          code: '// oxfmt-ignore\nconst x = 1;',
          errors: [{ messageId: 'missingDescription', data: { directive: 'oxfmt-ignore' } }],
        },
        {
          name: 'prettier-ignore with empty description after --',
          code: '// prettier-ignore --\nconst x = 1;',
          errors: [{ messageId: 'missingDescription', data: { directive: 'prettier-ignore' } }],
        },
        {
          name: 'prettier-ignore with only whitespace after --',
          code: '// prettier-ignore --   \nconst x = 1;',
          errors: [{ messageId: 'missingDescription', data: { directive: 'prettier-ignore' } }],
        },
        {
          name: 'block comment oxfmt-ignore without description',
          code: '/* oxfmt-ignore */\nconst x = 1;',
          errors: [{ messageId: 'missingDescription', data: { directive: 'oxfmt-ignore' } }],
        },
        {
          name: 'prettier-ignore with text but no -- separator',
          code: '// prettier-ignore some stuff\nconst x = 1;',
          errors: [{ messageId: 'missingDescription', data: { directive: 'prettier-ignore' } }],
        },
      ],
    });
  });
});
