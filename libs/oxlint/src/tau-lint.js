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
import { validateMdxLinksRule } from './rules/validate-mdx-links.js';
import { validateMdxExternalLinksRule } from './rules/validate-mdx-external-links.js';
import { noUselessCatchUnknownRule } from './rules/no-useless-catch-unknown.js';
import { noHardcodedColorRule } from './rules/no-hardcoded-color.js';

/** @type {Plugin} */
const plugin = {
  meta: {
    name: 'tau-lint',
    version: '1.11.0',
  },
  rules: {
    'no-abusive-eslint-disable': noAbusiveEslintDisableRule,
    'require-disable-description': requireDisableDescriptionRule,
    'require-ignore-description': requireIgnoreDescriptionRule,
    'no-literal-const-assertion': noLiteralConstAssertionRule,
    'no-useless-catch-unknown': noUselessCatchUnknownRule,
    'validate-jsdoc-codeblocks': validateJsdocCodeblocksRule,
    'require-public-export-jsdoc': requirePublicExportJsdocRule,
    'no-consecutive-jsdoc-blank-lines': noConsecutiveJsdocBlankLinesRule,
    'validate-mdx-codeblocks': validateMdxCodeblocksRule,
    'validate-mdx-links': validateMdxLinksRule,
    'validate-mdx-external-links': validateMdxExternalLinksRule,
    'no-hardcoded-color': noHardcodedColorRule,
  },
};

/** @public */
export default plugin;
