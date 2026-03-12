import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { validateJsdocCodeblocksRule } from './validate-jsdoc-codeblocks.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
  },
});

describe('validate-jsdoc-codeblocks', () => {
  describe('language tag requirement', () => {
    it('should report codeblocks without a language tag', () => {
      ruleTester.run('validate-jsdoc-codeblocks', validateJsdocCodeblocksRule, {
        valid: [
          {
            name: 'codeblock with typescript language tag',
            code: `
/**
 * @public
 * \`\`\`typescript
 * const x: number = 1;
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: 'codeblock with json language tag',
            code: `
/**
 * @public
 * \`\`\`json
 * { "key": "value" }
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: 'codeblock with text language tag',
            code: `
/**
 * @public
 * \`\`\`text
 * Some plain text
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: 'non-JSDoc block comment is ignored',
            code: `
/* Not a JSDoc comment
\`\`\`
no lang
\`\`\`
*/
const foo = 1;
`,
          },
          {
            name: 'line comments are ignored',
            code: '// Just a line comment\nconst foo = 1;',
          },
        ],
        invalid: [
          {
            name: 'codeblock without language tag in JSDoc',
            code: `
/**
 * @public
 * \`\`\`
 * const x = 1;
 * \`\`\`
 */
export const foo = 1;
`,
            errors: [{ messageId: 'missingLanguageTag' }],
          },
        ],
      });
    });
  });

  describe('TypeScript compilation', () => {
    it('should report TypeScript errors in @public codeblocks', () => {
      ruleTester.run('validate-jsdoc-codeblocks', validateJsdocCodeblocksRule, {
        valid: [
          {
            name: 'valid TypeScript in @public JSDoc',
            code: `
/**
 * @public
 * \`\`\`typescript
 * const x: number = 1;
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: 'TypeScript in non-@public JSDoc is not compile-checked',
            code: `
/**
 * @internal
 * \`\`\`typescript
 * const x: number = "not a number";
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: 'TypeScript in untagged JSDoc is not compile-checked',
            code: `
/**
 * \`\`\`typescript
 * const x: number = "not a number";
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: 'non-TypeScript codeblock in @public JSDoc skips compilation',
            code: `
/**
 * @public
 * \`\`\`json
 * { "invalid": json }
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: 'empty TypeScript codeblock in @public JSDoc',
            code: `
/**
 * @public
 * \`\`\`typescript
 * \`\`\`
 */
export const foo = 1;
`,
          },
        ],
        invalid: [
          {
            name: 'type error in @public TypeScript codeblock',
            code: `
/**
 * @public
 * \`\`\`typescript
 * const x: number = "not a number";
 * \`\`\`
 */
export const foo = 1;
`,
            errors: [{ messageId: 'invalidCodeblock' }],
          },
          {
            name: 'syntax error in @public TypeScript codeblock',
            code: `
/**
 * @public
 * \`\`\`typescript
 * const x: = ;
 * \`\`\`
 */
export const foo = 1;
`,
            errors: [{ messageId: 'invalidCodeblock' }, { messageId: 'invalidCodeblock' }],
          },
        ],
      });
    });
  });

  describe('star-prefix stripping', () => {
    it('should correctly compile codeblocks with star prefixes', () => {
      ruleTester.run('validate-jsdoc-codeblocks', validateJsdocCodeblocksRule, {
        valid: [
          {
            name: 'standard JSDoc formatting with star prefixes compiles correctly',
            code: `
/**
 * @public
 * \`\`\`typescript
 * const greeting: string = "hello";
 * const count: number = 42;
 * \`\`\`
 */
export const foo = 1;
`,
          },
        ],
        invalid: [],
      });
    });
  });

  describe('multiple codeblocks', () => {
    it('should report errors only for invalid codeblocks when multiple are present', () => {
      ruleTester.run('validate-jsdoc-codeblocks', validateJsdocCodeblocksRule, {
        valid: [
          {
            name: 'multiple valid TypeScript codeblocks',
            code: `
/**
 * @public
 * \`\`\`typescript
 * const a: number = 1;
 * \`\`\`
 *
 * \`\`\`typescript
 * const b: string = "hello";
 * \`\`\`
 */
export const foo = 1;
`,
          },
        ],
        invalid: [
          {
            name: 'one valid and one invalid codeblock',
            code: `
/**
 * @public
 * \`\`\`typescript
 * const a: number = 1;
 * \`\`\`
 *
 * \`\`\`typescript
 * const b: number = "wrong";
 * \`\`\`
 */
export const foo = 1;
`,
            errors: [{ messageId: 'invalidCodeblock' }],
          },
        ],
      });
    });
  });

  describe('@public tag variants', () => {
    it('should only compile-check codeblocks with @public tag', () => {
      ruleTester.run('validate-jsdoc-codeblocks', validateJsdocCodeblocksRule, {
        valid: [
          {
            name: '@publicAPI should not match (only exact @public)',
            code: `
/**
 * @publicAPI
 * \`\`\`typescript
 * const x: number = "not a number";
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: '@public at end of JSDoc line',
            code: `
/**
 * Some docs @public
 * \`\`\`typescript
 * const x: number = 1;
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: '@public followed by star (JSDoc continuation)',
            code: `
/**
 * @public
 * \`\`\`typescript
 * const x: number = 1;
 * \`\`\`
 */
export const foo = 1;
`,
          },
        ],
        invalid: [],
      });
    });
  });

  describe('@example caption enforcement', () => {
    it('should report bare text, missing captions, empty captions, and redundant "example" word', () => {
      ruleTester.run('validate-jsdoc-codeblocks', validateJsdocCodeblocksRule, {
        valid: [
          {
            name: 'caption with descriptive text is accepted',
            code: `
/**
 * @example <caption>Browser setup</caption>
 * \`\`\`typescript
 * const x = 1;
 * \`\`\`
 */
export const foo = 1;
`,
          },
        ],
        invalid: [
          {
            name: 'bare text after @example is wrapped in caption',
            code: `
/**
 * @example Browser setup
 * \`\`\`typescript
 * const x = 1;
 * \`\`\`
 */
export const foo = 1;
`,
            output: `
/**
 * @example <caption>Browser setup</caption>
 * \`\`\`typescript
 * const x = 1;
 * \`\`\`
 */
export const foo = 1;
`,
            errors: [{ messageId: 'exampleBareText' }],
          },
          {
            name: 'missing caption entirely',
            code: `
/**
 * @example
 * \`\`\`typescript
 * const x = 1;
 * \`\`\`
 */
export const foo = 1;
`,
            errors: [{ messageId: 'exampleMissingCaption' }],
          },
          {
            name: 'empty caption tag',
            code: `
/**
 * @example <caption></caption>
 * \`\`\`typescript
 * const x = 1;
 * \`\`\`
 */
export const foo = 1;
`,
            errors: [{ messageId: 'exampleEmptyCaption' }],
          },
          {
            name: 'redundant word "example" in caption',
            code: `
/**
 * @example <caption>Example of usage</caption>
 * \`\`\`typescript
 * const x = 1;
 * \`\`\`
 */
export const foo = 1;
`,
            errors: [{ messageId: 'exampleRedundantWord' }],
          },
        ],
      });
    });
  });

  describe('shorthand language tag expansion', () => {
    it('should report ts shorthand and suggest typescript', () => {
      ruleTester.run('validate-jsdoc-codeblocks', validateJsdocCodeblocksRule, {
        valid: [
          {
            name: 'typescript tag is accepted',
            code: `
/**
 * @public
 * \`\`\`typescript
 * const x: number = 1;
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: 'javascript tag is accepted',
            code: `
/**
 * \`\`\`javascript
 * const x = 1;
 * \`\`\`
 */
export const foo = 1;
`,
          },
        ],
        invalid: [
          {
            name: 'ts shorthand is flagged with fix',
            code: `
/**
 * \`\`\`ts
 * const x = 1;
 * \`\`\`
 */
export const foo = 1;
`,
            errors: [{ messageId: 'preferTypescriptTag' }],
            output: `
/**
 * \`\`\`typescript
 * const x = 1;
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: 'js shorthand is flagged with fix',
            code: `
/**
 * \`\`\`js
 * const x = 1;
 * \`\`\`
 */
export const foo = 1;
`,
            errors: [{ messageId: 'preferJavascriptTag' }],
            output: `
/**
 * \`\`\`javascript
 * const x = 1;
 * \`\`\`
 */
export const foo = 1;
`,
          },
        ],
      });
    });
  });
});
