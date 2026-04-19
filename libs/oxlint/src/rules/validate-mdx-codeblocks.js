/**
 * Type-checks fenced `typescript` code blocks in MDX files via tsgolint.
 * Blocks with `@ts-nocheck` in the fence meta string are skipped.
 * Diagnostics flow through ESLint's reporting pipeline so they appear in the IDE.
 *
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 * @typedef {import('eslint').Rule.RuleContext} RuleContext
 * @typedef {import('../tsgolint-utils.js').CodeblockEntry} CodeblockEntry
 */

import path from 'node:path';
import { resolveTsgolintBinary, runTsgolint } from '../tsgolint-utils.js';

// oxlint-disable-next-line unicorn-js/better-regex -- multiline flag + named groups require this form
const MDX_CODEBLOCK_REGEX = /^```typescript(?<meta>[^\n]*)?\n(?<code>[\s\S]*?)^```$/gm;

/** @type {RuleModule} */
export const validateMdxCodeblocksRule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Type-checks fenced TypeScript code blocks in MDX files via tsgolint (tsgo)',
    },
    messages: {
      typecheckError: '{{errorMessage}}',
    },
  },
  create(context) {
    return {
      Program() {
        const binary = resolveTsgolintBinary();
        if (!binary) {
          return;
        }

        const source = context.sourceCode.text;
        /** @type {CodeblockEntry[]} */
        const blocks = [];
        let blockIndex = 0;

        for (const match of source.matchAll(MDX_CODEBLOCK_REGEX)) {
          const meta = match.groups?.meta?.trim() ?? '';
          const code = match.groups?.code ?? '';

          if (meta.includes('@ts-nocheck') || !code.trim()) {
            continue;
          }

          const fenceLineLength = match[0].indexOf('\n') + 1;
          const codeStartIndex = (match.index ?? 0) + fenceLineLength;

          const basename = path.basename(context.filename, path.extname(context.filename));
          const directory = path.dirname(context.filename);
          const virtualPath = path.join(directory, `__mdx_${basename}_${blockIndex}.ts`);
          blockIndex++;

          blocks.push({
            virtualPath,
            strippedCode: code,
            codeStartIndex,
            mapToRaw: (offset) => offset,
          });
        }

        if (blocks.length === 0) {
          return;
        }

        const diagnostics = runTsgolint(binary, blocks);
        /** @type {Map<string, CodeblockEntry>} */
        const blockMap = new Map(blocks.map((block) => [block.virtualPath, block]));

        for (const diagnostic of diagnostics) {
          if (diagnostic.kind !== 1 || !diagnostic.file_path) {
            continue;
          }

          const block = blockMap.get(diagnostic.file_path);
          if (!block) {
            continue;
          }

          const startPos = diagnostic.range?.pos ?? 0;
          const endPos = diagnostic.range?.end ?? startPos;

          context.report({
            loc: {
              start: context.sourceCode.getLocFromIndex(block.codeStartIndex + startPos),
              end: context.sourceCode.getLocFromIndex(block.codeStartIndex + endPos),
            },
            messageId: 'typecheckError',
            data: {
              errorMessage: `${diagnostic.message.id}: ${diagnostic.message.description}`,
            },
          });
        }
      },
    };
  },
};
