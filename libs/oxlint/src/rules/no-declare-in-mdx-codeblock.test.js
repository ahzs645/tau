import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';

const { noDeclareInMdxCodeblockRule } = await import('./no-declare-in-mdx-codeblock.js');
const mdxParser = await import('../mdx-parser.js');

const ruleTester = new RuleTester({
  languageOptions: { parser: mdxParser },
});

describe('no-declare-in-mdx-codeblock', () => {
  describe('valid cases', () => {
    it('passes snippets that do not use declare or void no-ops', () => {
      ruleTester.run('no-declare-in-mdx-codeblock', noDeclareInMdxCodeblockRule, {
        valid: [
          {
            name: 'plain typescript snippet without declare or void',
            filename: '/docs/test.mdx',
            code: '```typescript\nconst x: number = 1;\nconsole.log(x);\n```',
          },
          {
            name: 'real call expression `void someFn()` is allowed (not a bare identifier)',
            filename: '/docs/test.mdx',
            code: '```typescript\nasync function run() {\n  void someFn();\n}\n```',
          },
          {
            name: 'declare inside non-typescript fence is ignored',
            filename: '/docs/test.mdx',
            code: '```javascript\ndeclare const x: string;\n```',
          },
          {
            name: 'declare inside text prose (not a fenced block) is ignored',
            filename: '/docs/test.mdx',
            code: '# Heading\n\nThe word `declare const` may appear in prose without triggering the rule.',
          },
          {
            name: 'plain markdown with no code blocks',
            filename: '/docs/test.mdx',
            code: '# Hello World\n\nSome text here.',
          },
          {
            name: 'fully real worker construction does not trip the rule',
            filename: '/docs/test.mdx',
            code: "```typescript\nconst worker = new Worker(new URL('./fs.ts', import.meta.url), { type: 'module' });\nworker.postMessage('hi');\n```",
          },
        ],
        invalid: [],
      });
    });
  });

  describe('declare keyword family', () => {
    it('flags `declare const` inside typescript codeblock', () => {
      ruleTester.run('no-declare-in-mdx-codeblock', noDeclareInMdxCodeblockRule, {
        valid: [],
        invalid: [
          {
            name: 'declare const',
            filename: '/docs/test.mdx',
            code: '```typescript\ndeclare const client: RuntimeClient;\nclient.terminate();\n```',
            errors: [{ messageId: 'noDeclare', data: { kind: 'const' } }],
          },
        ],
      });
    });

    it('flags `declare let`', () => {
      ruleTester.run('no-declare-in-mdx-codeblock', noDeclareInMdxCodeblockRule, {
        valid: [],
        invalid: [
          {
            name: 'declare let',
            filename: '/docs/test.mdx',
            code: '```typescript\ndeclare let port: MessagePort;\nport.start();\n```',
            errors: [{ messageId: 'noDeclare', data: { kind: 'let' } }],
          },
        ],
      });
    });

    it('flags `declare var`', () => {
      ruleTester.run('no-declare-in-mdx-codeblock', noDeclareInMdxCodeblockRule, {
        valid: [],
        invalid: [
          {
            name: 'declare var',
            filename: '/docs/test.mdx',
            code: '```typescript\ndeclare var legacy: number;\nconsole.log(legacy);\n```',
            errors: [{ messageId: 'noDeclare', data: { kind: 'var' } }],
          },
        ],
      });
    });

    it('flags `declare function`', () => {
      ruleTester.run('no-declare-in-mdx-codeblock', noDeclareInMdxCodeblockRule, {
        valid: [],
        invalid: [
          {
            name: 'declare function',
            filename: '/docs/test.mdx',
            code: '```typescript\ndeclare function makeClient(): RuntimeClient;\nmakeClient();\n```',
            errors: [{ messageId: 'noDeclare', data: { kind: 'function' } }],
          },
        ],
      });
    });

    it('flags `declare class`', () => {
      ruleTester.run('no-declare-in-mdx-codeblock', noDeclareInMdxCodeblockRule, {
        valid: [],
        invalid: [
          {
            name: 'declare class',
            filename: '/docs/test.mdx',
            code: '```typescript\ndeclare class RenderPipeline {}\nnew RenderPipeline();\n```',
            errors: [{ messageId: 'noDeclare', data: { kind: 'class' } }],
          },
        ],
      });
    });

    it('flags `declare enum`', () => {
      ruleTester.run('no-declare-in-mdx-codeblock', noDeclareInMdxCodeblockRule, {
        valid: [],
        invalid: [
          {
            name: 'declare enum',
            filename: '/docs/test.mdx',
            code: '```typescript\ndeclare enum Color { Red, Green }\nconsole.log(Color.Red);\n```',
            errors: [{ messageId: 'noDeclare', data: { kind: 'enum' } }],
          },
        ],
      });
    });

    it('flags `declare namespace`', () => {
      ruleTester.run('no-declare-in-mdx-codeblock', noDeclareInMdxCodeblockRule, {
        valid: [],
        invalid: [
          {
            name: 'declare namespace',
            filename: '/docs/test.mdx',
            code: '```typescript\ndeclare namespace Foo { const x: number; }\n```',
            errors: [{ messageId: 'noDeclare', data: { kind: 'namespace' } }],
          },
        ],
      });
    });

    it('flags `declare module`', () => {
      ruleTester.run('no-declare-in-mdx-codeblock', noDeclareInMdxCodeblockRule, {
        valid: [],
        invalid: [
          {
            name: 'declare module',
            filename: '/docs/test.mdx',
            code: "```typescript\ndeclare module 'foo' { const x: number; }\n```",
            errors: [{ messageId: 'noDeclare', data: { kind: 'module' } }],
          },
        ],
      });
    });
  });

  describe('void no-op statements', () => {
    it('flags bare `void IDENT;` statement', () => {
      ruleTester.run('no-declare-in-mdx-codeblock', noDeclareInMdxCodeblockRule, {
        valid: [],
        invalid: [
          {
            name: 'void dispose;',
            filename: '/docs/test.mdx',
            code: '```typescript\nconst dispose = () => {};\nvoid dispose;\n```',
            errors: [{ messageId: 'noVoidNoOp', data: { ident: 'dispose' } }],
          },
        ],
      });
    });

    it('flags `void IDENT` without a trailing semicolon', () => {
      ruleTester.run('no-declare-in-mdx-codeblock', noDeclareInMdxCodeblockRule, {
        valid: [],
        invalid: [
          {
            name: 'void port (no semi)',
            filename: '/docs/test.mdx',
            code: '```typescript\nconst port = new MessageChannel().port1;\nvoid port\n```',
            errors: [{ messageId: 'noVoidNoOp', data: { ident: 'port' } }],
          },
        ],
      });
    });
  });

  describe('@ts-nocheck blocks are still scanned', () => {
    it('flags declare even inside a @ts-nocheck block', () => {
      ruleTester.run('no-declare-in-mdx-codeblock', noDeclareInMdxCodeblockRule, {
        valid: [],
        invalid: [
          {
            name: '@ts-nocheck does not silence this rule',
            filename: '/docs/test.mdx',
            code: '```typescript @ts-nocheck\ndeclare const port: MessagePort;\nport.start();\n```',
            errors: [{ messageId: 'noDeclare', data: { kind: 'const' } }],
          },
        ],
      });
    });
  });

  describe('multiple violations in one block', () => {
    it('reports each declare and void on its own line', () => {
      ruleTester.run('no-declare-in-mdx-codeblock', noDeclareInMdxCodeblockRule, {
        valid: [],
        invalid: [
          {
            name: 'two declares + one void',
            filename: '/docs/test.mdx',
            code: [
              '```typescript',
              'declare const fsWorker: Worker;',
              'declare function createBridge(): { dispose(): void };',
              'const dispose = createBridge().dispose;',
              'void dispose;',
              '```',
            ].join('\n'),
            errors: [
              { messageId: 'noDeclare', data: { kind: 'const' } },
              { messageId: 'noDeclare', data: { kind: 'function' } },
              { messageId: 'noVoidNoOp', data: { ident: 'dispose' } },
            ],
          },
        ],
      });
    });
  });
});
