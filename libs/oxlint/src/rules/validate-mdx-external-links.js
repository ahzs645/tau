/**
 * Validates that external URLs in MDX files are reachable.
 * Spawns a subprocess that checks URLs via HTTP HEAD/GET with disk caching.
 * Dead links (404/410) are reported as errors; network failures as warnings.
 *
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 * @typedef {import('eslint').Rule.RuleContext} RuleContext
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

// oxlint-disable-next-line unicorn-js/better-regex -- escaped bracket in named group requires this form
const MARKDOWN_LINK_REGEX = /\[(?<text>[^\]]*)\]\((?<url>[^)]+)\)/g;
const EXTERNAL_URL_REGEX = /^https?:\/\//i;
// oxlint-disable-next-line unicorn-js/better-regex -- character class order is intentional for readability
const LOCALHOST_REGEX = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)[:/]/i;
const CHECKER_SCRIPT = path.join(import.meta.dirname, '..', 'external-link-checker.js');
const SUBPROCESS_TIMEOUT_MS = 60_000;

/**
 * @typedef {{ url: string; status: 'alive' | 'dead' | 'error'; statusCode?: number; error?: string }} CheckResult
 * @typedef {{ url: string; urlStart: number; urlEnd: number }} ExtractedLink
 */

/**
 * @param {string[]} urls
 * @returns {CheckResult[]}
 */
const runChecker = (urls) => {
  try {
    const result = execFileSync('node', [CHECKER_SCRIPT], {
      input: JSON.stringify(urls),
      encoding: 'utf8',
      timeout: SUBPROCESS_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** @type {CheckResult[]} */
    const parsed = JSON.parse(result);
    return parsed;
  } catch {
    return [];
  }
};

/** @type {RuleModule} */
export const validateMdxExternalLinksRule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Validates that external URLs in MDX files are reachable',
    },
    messages: {
      deadExternalLink: 'Dead external link: "{{url}}" returned HTTP {{statusCode}}',
      unreachableExternalLink: 'Unreachable external link: "{{url}}" ({{error}})',
    },
  },
  create(context) {
    return {
      Program() {
        const source = context.sourceCode.text;

        /** @type {ExtractedLink[]} */
        const links = [];
        /** @type {Set<string>} */
        const seenUrls = new Set();

        for (const match of source.matchAll(MARKDOWN_LINK_REGEX)) {
          const rawUrl = match.groups?.url ?? '';
          const href = rawUrl.split('#')[0];

          if (!EXTERNAL_URL_REGEX.test(href)) {
            continue;
          }
          if (LOCALHOST_REGEX.test(href)) {
            continue;
          }

          const matchIndex = match.index ?? 0;
          const urlStart = matchIndex + match[0].lastIndexOf(`(${rawUrl}`) + 1;
          const urlEnd = urlStart + rawUrl.length;

          links.push({ url: href, urlStart, urlEnd });
          seenUrls.add(href);
        }

        if (seenUrls.size === 0) {
          return;
        }

        const results = runChecker([...seenUrls]);
        /** @type {Map<string, CheckResult>} */
        const resultMap = new Map(results.map((r) => [r.url, r]));

        for (const link of links) {
          const result = resultMap.get(link.url);
          if (!result) {
            continue;
          }

          if (result.status === 'dead') {
            context.report({
              loc: {
                start: context.sourceCode.getLocFromIndex(link.urlStart),
                end: context.sourceCode.getLocFromIndex(link.urlEnd),
              },
              messageId: 'deadExternalLink',
              data: { url: link.url, statusCode: String(result.statusCode ?? 'unknown') },
            });
          } else if (result.status === 'error') {
            context.report({
              loc: {
                start: context.sourceCode.getLocFromIndex(link.urlStart),
                end: context.sourceCode.getLocFromIndex(link.urlEnd),
              },
              messageId: 'unreachableExternalLink',
              data: { url: link.url, error: result.error ?? 'Unknown error' },
            });
          }
        }
      },
    };
  },
};
