/**
 * Custom oxlint JS plugin: tau-lint
 *
 * Replaces the built-in unicorn/no-abusive-eslint-disable rule with a version
 * that tolerates eslint-disable comments referencing ESLint-only plugin prefixes
 * (e.g. n/, import-x/) that oxlint doesn't natively recognise.
 *
 * In the hybrid oxlint+ESLint setup, disable comments targeting ESLint-only
 * rules are valid for ESLint but look "abusive" to oxlint because it can't
 * validate external plugin namespaces. This plugin simply checks whether a
 * disable directive specifies *any* rule names — if it does, it's not abusive,
 * regardless of whether oxlint knows the rule.
 *
 * Also enforces that every disable comment includes a human-readable
 * description after `--`, mirroring the ESLint `require-description` rule
 * for oxlint-disable comments.
 *
 * Stop-gap until oxlint natively supports external plugin namespace awareness.
 *
 * @typedef {import('eslint').AST.Token} Token
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 * @typedef {import('eslint').Rule.RuleContext} RuleContext
 * @typedef {import('eslint').ESLint.Plugin} Plugin
 */

/** Matches any eslint/oxlint disable directive and captures everything after the keyword. */
const BLANKET_DISABLE_PATTERN = /^\s*(?:eslint-disable|oxlint-disable)(?:-next-line|-line)?\s*(.*)/;

/** Same as above but requires at least one non-whitespace char after the directive keyword. */
const DIRECTIVE_WITH_RULES_PATTERN = /^\s*(?:eslint-disable|oxlint-disable)(?:-next-line|-line)?\s+(.*)/;

/**
 * Return whether a directive line specifies at least one rule name.
 * @param {string} commentText - A single trimmed line from within a comment.
 * @returns {boolean}
 */
function hasRuleNames(commentText) {
  const match = BLANKET_DISABLE_PATTERN.exec(commentText);
  if (!match) {
    return true;
  }

  const afterDirective = match[1].trim();
  if (!afterDirective || afterDirective.startsWith('--')) {
    return false;
  }

  const rulesPart = afterDirective.split('--')[0].trim();
  return rulesPart.length > 0;
}

/**
 * @param {Token} comment
 * @returns {boolean}
 */
function isDisableComment(comment) {
  return comment.value.includes('eslint-disable') || comment.value.includes('oxlint-disable');
}

/**
 * Normalise a line inside a block comment by stripping leading `*` markers.
 * @param {string} line
 * @returns {string}
 */
function normaliseCommentLine(line) {
  return line.trim().replace(/^\*\s*/, '');
}

/**
 * @param {Token} comment
 * @returns {boolean}
 */
function isDirectiveLine(comment) {
  const text = normaliseCommentLine(comment.type === 'Block' ? comment.value : comment.value);
  return text.startsWith('eslint-disable') || text.startsWith('oxlint-disable');
}

/**
 * Iterate over logical lines within a comment (block comments can span many).
 * @param {Token} comment
 * @returns {string[]}
 */
function getCommentLines(comment) {
  return comment.type === 'Block' ? comment.value.split('\n') : [comment.value];
}

// ---------------------------------------------------------------------------
// Rule: no-abusive-eslint-disable
// ---------------------------------------------------------------------------

/** @type {RuleModule} */
const noAbusiveEslintDisableRule = {
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

// ---------------------------------------------------------------------------
// Rule: require-disable-description
// ---------------------------------------------------------------------------

/** @type {RuleModule} */
const requireDisableDescriptionRule = {
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

// ---------------------------------------------------------------------------
// Rule: require-ignore-description
// ---------------------------------------------------------------------------

const IGNORE_PATTERN = /^\s*(prettier-ignore|oxfmt-ignore)\s*(.*)/;

/** @type {RuleModule} */
const requireIgnoreDescriptionRule = {
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

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

/** @type {Plugin} */
const plugin = {
  meta: {
    name: 'tau-lint',
    version: '1.0.0',
  },
  rules: {
    'no-abusive-eslint-disable': noAbusiveEslintDisableRule,
    'require-disable-description': requireDisableDescriptionRule,
    'require-ignore-description': requireIgnoreDescriptionRule,
  },
};

export default plugin;
