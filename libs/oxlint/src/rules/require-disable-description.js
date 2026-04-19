/**
 * @typedef {import('eslint').AST.Token} Token
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 */

import {
  DIRECTIVE_WITH_RULES_PATTERN,
  getCommentLines,
  isDirectiveLine,
  isDisableComment,
  normaliseCommentLine,
} from '../utils/disable-comment.utils.js';

/** @type {RuleModule} */
export const requireDisableDescriptionRule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require a description after `--` on eslint-disable / oxlint-disable comments',
    },
    messages: {
      missingDescription:
        'Disable comment for "{{rules}}" is missing a description. Add ` -- <reason>` after the rule name(s).',
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

            const match = DIRECTIVE_WITH_RULES_PATTERN.exec(trimmed);
            if (!match) {
              continue;
            }

            const afterDirective = match[1].trim();
            const parts = afterDirective.split('--');
            const rulesPart = parts[0].trim();

            if (!rulesPart) {
              continue;
            }

            const descriptionPart = parts.length > 1 ? parts.slice(1).join('--').trim() : '';

            if (!descriptionPart) {
              context.report({
                loc: comment.loc,
                messageId: 'missingDescription',
                data: { rules: rulesPart },
              });
              break;
            }
          }
        }
      },
    };
  },
};
