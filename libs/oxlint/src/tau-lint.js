/**
 * Custom oxlint JS plugin: tau-lint
 *
 * Aggregates all tau-lint rules into a single plugin export.
 * Each rule lives in its own file under `./rules/`.
 *
 * @typedef {import('eslint').ESLint.Plugin} Plugin
 */

import { noAbusiveEslintDisableRule } from './rules/no-abusive-eslint-disable.js';
import { noLiteralConstAssertionRule } from './rules/no-literal-const-assertion.js';
import { requireDisableDescriptionRule } from './rules/require-disable-description.js';
import { requireIgnoreDescriptionRule } from './rules/require-ignore-description.js';
import { validateJsdocCodeblocksRule } from './rules/validate-jsdoc-codeblocks.js';
import { requirePublicExportJsdocRule } from './rules/require-public-export-jsdoc.js';
import { noConsecutiveJsdocBlankLinesRule } from './rules/no-consecutive-jsdoc-blank-lines.js';
import { validateMdxCodeblocksRule } from './rules/validate-mdx-codeblocks.js';
import * as mdxParser from './mdx-parser.js';

/** @type {Plugin} */
const plugin = {
  meta: {
    name: 'tau-lint',
    version: '1.7.0',
  },
  parsers: {
    mdx: mdxParser,
  },
  rules: {
    'no-abusive-eslint-disable': noAbusiveEslintDisableRule,
    'require-disable-description': requireDisableDescriptionRule,
    'require-ignore-description': requireIgnoreDescriptionRule,
    'no-literal-const-assertion': noLiteralConstAssertionRule,
    'validate-jsdoc-codeblocks': validateJsdocCodeblocksRule,
    'require-public-export-jsdoc': requirePublicExportJsdocRule,
    'no-consecutive-jsdoc-blank-lines': noConsecutiveJsdocBlankLinesRule,
    'validate-mdx-codeblocks': validateMdxCodeblocksRule,
  },
};

/** @public */
export default plugin;
