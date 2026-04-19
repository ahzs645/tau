/**
 * Validates that markdown links in MDX files point to existing pages.
 * Checks both relative links (e.g., `../api/client`) and absolute links
 * (e.g., `/docs/runtime/api/client`) by resolving them to filesystem paths
 * and verifying the target `.mdx` or `index.mdx` file exists.
 *
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 * @typedef {import('eslint').Rule.RuleContext} RuleContext
 */

import fs from 'node:fs';
import path from 'node:path';

// oxlint-disable-next-line unicorn-js/better-regex -- escaped bracket in named group requires this form
const MARKDOWN_LINK_REGEX = /\[(?<text>[^\]]*)\]\((?<url>[^)]+)\)/g;
const EXTERNAL_REGEX = /^(?:https?:|mailto:|tel:|ftp:|#)/i;
const CONTENT_DOCS_SEGMENT = `content${path.sep}docs`;

/**
 * @param {string} filePath
 * @returns {string | undefined}
 */
const findContentDocsRoot = (filePath) => {
  const index = filePath.indexOf(CONTENT_DOCS_SEGMENT);
  if (index === -1) {
    return undefined;
  }
  return filePath.slice(0, index + CONTENT_DOCS_SEGMENT.length);
};

/**
 * Scans a directory for route group folders (folders starting with `(`).
 * Returns a map from bare name to actual folder name, e.g. `runtime` → `(runtime)`.
 *
 * @param {string} directory
 * @returns {Map<string, string>}
 */
const scanRouteGroups = (directory) => {
  /** @type {Map<string, string>} */
  const groups = new Map();
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('(') && entry.name.endsWith(')')) {
        const bare = entry.name.slice(1, -1);
        groups.set(bare, entry.name);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }
  return groups;
};

/**
 * @param {string} resolved  Resolved path without extension
 * @returns {boolean}
 */
const targetExists = (resolved) => fs.existsSync(`${resolved}.mdx`) || fs.existsSync(path.join(resolved, 'index.mdx'));

/**
 * @typedef {{ context: RuleContext; href: string; rawUrl: string; urlStart: number; urlEnd: number }} LinkValidationOptions
 */

/**
 * @param {LinkValidationOptions & { fileDirectory: string }} options
 */
const validateRelativeLink = ({ context, href, rawUrl, fileDirectory, urlStart, urlEnd }) => {
  const resolved = path.resolve(fileDirectory, href);

  if (!targetExists(resolved)) {
    context.report({
      loc: {
        start: context.sourceCode.getLocFromIndex(urlStart),
        end: context.sourceCode.getLocFromIndex(urlEnd),
      },
      messageId: 'deadLink',
      data: { url: rawUrl, resolvedPath: `${resolved}.mdx` },
    });
  }
};

/**
 * @param {LinkValidationOptions} options
 */
const validateAbsoluteLink = ({ context, href, rawUrl, urlStart, urlEnd }) => {
  const contentRoot = findContentDocsRoot(context.filename);
  if (!contentRoot) {
    return;
  }

  const withoutBase = href.replace(/^\/docs\/?/, '');
  if (!withoutBase) {
    return;
  }

  const segments = withoutBase.split('/');
  const routeGroups = scanRouteGroups(contentRoot);

  const firstSegment = segments[0];
  const mappedFirst = routeGroups.get(firstSegment);
  if (mappedFirst) {
    segments[0] = mappedFirst;
  }

  const resolved = path.join(contentRoot, ...segments);

  if (!targetExists(resolved)) {
    context.report({
      loc: {
        start: context.sourceCode.getLocFromIndex(urlStart),
        end: context.sourceCode.getLocFromIndex(urlEnd),
      },
      messageId: 'deadLink',
      data: { url: rawUrl, resolvedPath: `${resolved}.mdx` },
    });
  }
};

/** @type {RuleModule} */
export const validateMdxLinksRule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Validates that markdown links in MDX files resolve to existing pages',
    },
    messages: {
      deadLink: 'Dead link: "{{url}}" does not resolve to an existing page (tried {{resolvedPath}})',
    },
  },
  create(context) {
    return {
      Program() {
        const source = context.sourceCode.text;
        const fileDirectory = path.dirname(context.filename);

        for (const match of source.matchAll(MARKDOWN_LINK_REGEX)) {
          const rawUrl = match.groups?.url ?? '';
          if (EXTERNAL_REGEX.test(rawUrl)) {
            continue;
          }

          const href = rawUrl.split('#')[0];
          if (!href) {
            continue;
          }

          const matchIndex = match.index ?? 0;
          const urlStart = matchIndex + match[0].lastIndexOf(`(${rawUrl}`) + 1;
          const urlEnd = urlStart + rawUrl.length;

          /** @type {LinkValidationOptions} */
          const options = { context, href, rawUrl, urlStart, urlEnd };

          if (href.startsWith('/')) {
            validateAbsoluteLink(options);
          } else {
            validateRelativeLink({ ...options, fileDirectory });
          }
        }
      },
    };
  },
};
