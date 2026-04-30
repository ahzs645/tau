/**
 * Bans TypeScript test-fixture idioms inside fenced `typescript` MDX codeblocks:
 * - `declare const|let|var|function|class|enum|namespace|module ...`
 * - `void IDENT;` no-op statements (used to silence "declared but unused")
 *
 * These patterns make documentation snippets read as test fixtures rather than
 * realistic consumer code. See `documentation-policy.md` §3.1/§3.3/§3.5 and
 * the "Cross-cutting principle" of the
 * `replace_declare-const_anti-pattern_in_mdx_docs` plan for the canonical
 * inline-construction patterns to use instead.
 *
 * Unlike `validate-mdx-codeblocks`, this rule does NOT skip `@ts-nocheck`
 * blocks -- the anti-pattern is independent of whether the block type-checks.
 *
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 */

// oxlint-disable-next-line unicorn-js/better-regex -- multiline flag + named groups require this form
const MDX_CODEBLOCK_REGEX = /^```typescript(?<meta>[^\n]*)?\n(?<code>[\s\S]*?)^```$/gm;

const DECLARE_REGEX = /^[\t ]*declare\s+(?<kind>const|let|var|function|class|enum|namespace|module)\b/gm;
const VOID_NOOP_REGEX = /^[\t ]*void\s+(?<ident>[$A-Z_a-z][\w$]*)\s*;?\s*$/gm;

/** @type {RuleModule} */
export const noDeclareInMdxCodeblockRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow `declare const|let|var|function|class|enum|namespace|module` and `void IDENT;` no-ops inside fenced typescript MDX codeblocks. ' +
        'These TypeScript test-fixture idioms make documentation snippets read as fixtures rather than realistic consumer code. ' +
        'Inline real values, factories, or workers instead (see the documentation-policy.md §5 contract).',
    },
    messages: {
      noDeclare:
        '`declare {{kind}}` is a TypeScript test-fixture idiom, not example code. ' +
        'Inline a real value or factory instead -- e.g. `const worker = new Worker(new URL(...), { type: "module" })`, ' +
        '`const myKernel = () => defineKernel({ ... })`, or a real string literal. ' +
        'See the cross-cutting principle of the replace_declare-const_anti-pattern_in_mdx_docs plan.',
      noVoidNoOp:
        '`void {{ident}};` no-op statement only exists to silence "declared but unused". ' +
        'Use the value meaningfully (e.g. `console.log({{ident}})`, `return {{ident}}`, or a real call) ' +
        'or remove the surrounding `declare`/unused binding.',
    },
  },
  create(context) {
    return {
      Program() {
        const source = context.sourceCode.text;

        for (const blockMatch of source.matchAll(MDX_CODEBLOCK_REGEX)) {
          const code = blockMatch.groups?.code ?? '';
          if (!code.trim()) {
            continue;
          }

          const fenceLineLength = blockMatch[0].indexOf('\n') + 1;
          const codeStartIndex = (blockMatch.index ?? 0) + fenceLineLength;

          for (const declareMatch of code.matchAll(DECLARE_REGEX)) {
            const kind = declareMatch.groups?.kind ?? '';
            const matchStart = codeStartIndex + (declareMatch.index ?? 0);
            const matchEnd = matchStart + declareMatch[0].length;
            context.report({
              loc: {
                start: context.sourceCode.getLocFromIndex(matchStart),
                end: context.sourceCode.getLocFromIndex(matchEnd),
              },
              messageId: 'noDeclare',
              data: { kind },
            });
          }

          for (const voidMatch of code.matchAll(VOID_NOOP_REGEX)) {
            const ident = voidMatch.groups?.ident ?? '';
            const matchStart = codeStartIndex + (voidMatch.index ?? 0);
            const matchEnd = matchStart + voidMatch[0].length;
            context.report({
              loc: {
                start: context.sourceCode.getLocFromIndex(matchStart),
                end: context.sourceCode.getLocFromIndex(matchEnd),
              },
              messageId: 'noVoidNoOp',
              data: { ident },
            });
          }
        }
      },
    };
  },
};
