/**
 * Shared helpers for disable-comment lint rules.
 *
 * @typedef {import('eslint').AST.Token} Token
 */

/** Matches any eslint/oxlint disable directive and captures everything after the keyword. */
export const BLANKET_DISABLE_PATTERN = /^\s*(?:eslint-disable|oxlint-disable)(?:-next-line|-line)?\s*(.*)/;

/** Same as above but requires at least one non-whitespace char after the directive keyword. */
export const DIRECTIVE_WITH_RULES_PATTERN = /^\s*(?:eslint-disable|oxlint-disable)(?:-next-line|-line)?\s+(.*)/;

/**
 * Return whether a directive line specifies at least one rule name.
 * @param {string} commentText - A single trimmed line from within a comment.
 * @returns {boolean}
 */
export function hasRuleNames(commentText) {
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
export function isDisableComment(comment) {
  return comment.value.includes('eslint-disable') || comment.value.includes('oxlint-disable');
}

/**
 * Normalise a line inside a block comment by stripping leading `*` markers.
 * @param {string} line
 * @returns {string}
 */
export function normaliseCommentLine(line) {
  return line.trim().replace(/^\*\s*/, '');
}

/**
 * @param {Token} comment
 * @returns {boolean}
 */
export function isDirectiveLine(comment) {
  const text = normaliseCommentLine(comment.type === 'Block' ? comment.value : comment.value);
  return text.startsWith('eslint-disable') || text.startsWith('oxlint-disable');
}

/**
 * Iterate over logical lines within a comment (block comments can span many).
 * @param {Token} comment
 * @returns {string[]}
 */
export function getCommentLines(comment) {
  return comment.type === 'Block' ? comment.value.split('\n') : [comment.value];
}
