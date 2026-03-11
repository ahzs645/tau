/**
 * @typedef {import('eslint').AST.Token} Token
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 */

import {
  getCommentLines,
  hasRuleNames,
  isDirectiveLine,
  isDisableComment,
  normaliseCommentLine,
} from '../utils/disable-comment.utils.js';

/** @type {RuleModule} */
export const noAbusiveEslintDisableRule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow eslint-disable / oxlint-disable comments without specifying rules (hybrid-aware)',
    },
    messages: {
      abusive: 'Unexpected `eslint-disable` comment that does not specify any rules to disable.',
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (!isDisableComment(comment)) {
            continue;
          }

          for (const line of getCommentLines(comment)) {
            const trimmed = normaliseCommentLine(line);
            if (!isDirectiveLine(/** @type {Token} */ ({ value: trimmed }))) {
              continue;
            }

            if (!hasRuleNames(trimmed)) {
              context.report({ loc: comment.loc, messageId: 'abusive' });
              break;
            }
          }
        }
      },
    };
  },
};
