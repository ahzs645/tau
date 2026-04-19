/**
 * Minimal passthrough parser for MDX files.
 * Returns a valid ESTree Program AST without actually parsing MDX syntax.
 * ESLint computes SourceCode.getLocFromIndex() from the raw text, so custom
 * rules get full position-mapping capabilities with no MDX-specific dependency.
 */

/**
 * @param {string} text
 * @returns {import('estree').Program & { range: [number, number]; loc: import('estree').SourceLocation; tokens: never[]; comments: never[] }}
 *
 * @public
 */
export const parse = (text) => {
  const lines = text.split('\n');
  return {
    type: 'Program',
    body: [],
    sourceType: 'module',
    range: [0, text.length],
    loc: {
      start: { line: 1, column: 0 },
      end: { line: lines.length, column: lines.at(-1)?.length ?? 0 },
    },
    tokens: [],
    comments: [],
  };
};
