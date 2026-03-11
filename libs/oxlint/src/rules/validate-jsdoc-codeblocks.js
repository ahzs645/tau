/**
 * Validates that fenced TypeScript codeblocks in JSDoc comments compile
 * without errors, and requires all JSDoc fenced codeblocks to specify a
 * language tag. Only compile-checks codeblocks in `@public`-tagged JSDoc;
 * `@internal` or untagged JSDoc still gets syntax highlighting but skips
 * compilation. Adapted from type-fest's validate-jsdoc-codeblocks ESLint
 * rule, with a star-prefix stripping layer for standard JSDoc formatting.
 *
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 */

import path from 'node:path';
import ts from 'typescript';
import { createFSBackedSystem, createVirtualTypeScriptEnvironment } from '@typescript/vfs';

// oxlint-disable-next-line unicorn-js/better-regex -- named capture groups should not be reordered
const CODEBLOCK_REGEX = /(?<openingFence>```(?<lang>[a-zA-Z]*)\n)(?<code>[\s\S]*?)```/g;
const TS_LANGS = new Set(['ts', 'typescript']);
const PUBLIC_TAG_REGEX = /@public(?:\s|$|\*)/;
const FILENAME = 'example-codeblock.ts';

const compilerOptions = {
  lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noUnusedLocals: false,
  noUnusedParameters: false,
  noImplicitReturns: false,
  skipLibCheck: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
};

const rootDirectory = path.resolve(import.meta.dirname, '..', '..', '..', '..');
/** @type {Map<string, string>} */
const virtualFsMap = new Map();
virtualFsMap.set(FILENAME, '// placeholder');

const system = createFSBackedSystem(virtualFsMap, rootDirectory, ts);
const defaultEnvironment = createVirtualTypeScriptEnvironment(system, [FILENAME], ts, compilerOptions);

/**
 * Strip leading ` * ` prefixes from JSDoc codeblock lines and provide an
 * offset mapping function to translate stripped-code positions back to
 * positions in the raw (prefixed) code.
 *
 * @param {string} rawCode - Code extracted from between fences (with `*` prefixes)
 */
function stripStarPrefixes(rawCode) {
  const lines = rawCode.split('\n');
  /** @type {string[]} */
  const strippedLines = [];
  /** @type {number[]} */
  const prefixLengths = [];

  for (const line of lines) {
    const starMatch = /^(\s*\*\s?)/.exec(line);
    const prefixLength = starMatch ? starMatch[1].length : 0;
    prefixLengths.push(prefixLength);
    strippedLines.push(line.slice(prefixLength));
  }

  return {
    code: strippedLines.join('\n'),
    /**
     * Map an offset in the stripped code back to the corresponding offset
     * in the raw (star-prefixed) code.
     * @param {number} strippedOffset
     * @returns {number}
     */
    mapToRaw(strippedOffset) {
      let pos = 0;
      for (let i = 0; i < strippedLines.length; i++) {
        const lineLength = strippedLines[i].length;
        if (pos + lineLength >= strippedOffset || i === strippedLines.length - 1) {
          const col = strippedOffset - pos;
          let rawPos = 0;
          for (let j = 0; j < i; j++) {
            rawPos += prefixLengths[j] + strippedLines[j].length + 1;
          }
          rawPos += prefixLengths[i] + col;
          return rawPos;
        }
        pos += lineLength + 1;
      }
      return strippedOffset;
    },
  };
}

/** @type {RuleModule} */
export const validateJsdocCodeblocksRule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Ensures JSDoc example codeblocks compile without TypeScript errors',
    },
    messages: {
      invalidCodeblock: '{{errorMessage}}',
      missingLanguageTag: 'JSDoc fenced codeblock must specify a language tag (e.g., ts, json, text)',
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type !== 'Block' || !comment.value.startsWith('*')) {
            continue;
          }

          for (const match of comment.value.matchAll(CODEBLOCK_REGEX)) {
            const { code: rawCode, openingFence, lang } = match.groups ?? {};

            if (!openingFence) {
              continue;
            }

            if (!lang) {
              const fenceIndex = comment.range[0] + match.index + 2;
              context.report({
                loc: {
                  start: context.sourceCode.getLocFromIndex(fenceIndex),
                  end: context.sourceCode.getLocFromIndex(fenceIndex + openingFence.length),
                },
                messageId: 'missingLanguageTag',
              });
              continue;
            }

            if (!TS_LANGS.has(lang) || !rawCode?.trim()) {
              continue;
            }

            if (!PUBLIC_TAG_REGEX.test(comment.value)) {
              continue;
            }

            const matchOffset = match.index + openingFence.length + 2;
            const codeStartIndex = comment.range[0] + matchOffset;

            const { code, mapToRaw } = stripStarPrefixes(rawCode);

            if (!code.trim()) {
              continue;
            }

            defaultEnvironment.updateFile(FILENAME, code);
            const syntacticDiagnostics = defaultEnvironment.languageService.getSyntacticDiagnostics(FILENAME);
            const semanticDiagnostics = defaultEnvironment.languageService.getSemanticDiagnostics(FILENAME);
            const diagnostics = syntacticDiagnostics.length > 0 ? syntacticDiagnostics : semanticDiagnostics;

            for (const diagnostic of diagnostics) {
              const rawStart = mapToRaw(diagnostic.start ?? 0);
              const rawEnd = mapToRaw((diagnostic.start ?? 0) + (diagnostic.length ?? code.length));
              const diagnosticStart = codeStartIndex + rawStart;
              const diagnosticEnd = codeStartIndex + rawEnd;

              context.report({
                loc: {
                  start: context.sourceCode.getLocFromIndex(diagnosticStart),
                  end: context.sourceCode.getLocFromIndex(diagnosticEnd),
                },
                messageId: 'invalidCodeblock',
                data: {
                  errorMessage: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
                },
              });
            }
          }
        }
      },
    };
  },
};
