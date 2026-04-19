/**
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 */

import { getCommentLines, normaliseCommentLine } from '../utils/disable-comment.utils.js';

const IGNORE_PATTERN = /^\s*(prettier-ignore|oxfmt-ignore)\s*(.*)/;

/** @type {RuleModule} */
export const requireIgnoreDescriptionRule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require a description after `--` on prettier-ignore / oxfmt-ignore comments',
    },
    messages: {
      missingDescription: '`{{directive}}` comment is missing a description. Add ` -- <reason>` after the directive.',
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          for (const line of getCommentLines(comment)) {
            const trimmed = normaliseCommentLine(line);
            const match = IGNORE_PATTERN.exec(trimmed);
            if (!match) {
              continue;
            }

            const directive = match[1];
            const rest = match[2].trim();
            const descriptionPart = rest.startsWith('--') ? rest.slice(2).trim() : '';

            if (!descriptionPart) {
              context.report({
                loc: comment.loc,
                messageId: 'missingDescription',
                data: { directive },
              });
            }
          }
        }
      },
    };
  },
};
