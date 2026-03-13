import { describe, it, vi, beforeEach } from 'vitest';
import { RuleTester } from 'eslint';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => '[]'),
}));

const { execFileSync } = await import('node:child_process');
const { validateMdxExternalLinksRule } = await import('./validate-mdx-external-links.js');
const mdxParser = await import('../mdx-parser.js');

const ruleTester = new RuleTester({
  languageOptions: { parser: mdxParser },
});

/**
 * @param {Array<{ url: string; status: string; statusCode?: number; error?: string }>} results
 */
const mockCheckerResults = (results) => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify(results));
};

describe('validate-mdx-external-links', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReturnValue('[]');
  });

  describe('link extraction', () => {
    it('should skip non-http links', () => {
      ruleTester.run('validate-mdx-external-links', validateMdxExternalLinksRule, {
        valid: [
          {
            name: 'relative link is skipped',
            filename: '/docs/test.mdx',
            code: 'See [guide](./quick-start) for details.',
          },
          {
            name: 'mailto link is skipped',
            filename: '/docs/test.mdx',
            code: 'Email [us](mailto:hello@example.com).',
          },
          {
            name: 'anchor-only link is skipped',
            filename: '/docs/test.mdx',
            code: 'Jump to [section](#overview).',
          },
          {
            name: 'plain text with no links',
            filename: '/docs/test.mdx',
            code: '# Hello World\n\nSome text here.',
          },
        ],
        invalid: [],
      });
    });

    it('should skip localhost URLs', () => {
      mockCheckerResults([]);

      ruleTester.run('validate-mdx-external-links', validateMdxExternalLinksRule, {
        valid: [
          {
            name: 'localhost URL is skipped',
            filename: '/docs/test.mdx',
            code: 'See [local](http://localhost:3000/api).',
          },
          {
            name: '127.0.0.1 URL is skipped',
            filename: '/docs/test.mdx',
            code: 'See [local](http://127.0.0.1:8080/test).',
          },
          {
            name: '0.0.0.0 URL is skipped',
            filename: '/docs/test.mdx',
            code: 'See [local](http://0.0.0.0:5000/health).',
          },
        ],
        invalid: [],
      });
    });
  });

  describe('alive URLs', () => {
    it('should pass when all external links are alive', () => {
      mockCheckerResults([
        { url: 'https://example.com', status: 'alive', statusCode: 200 },
        { url: 'https://github.com', status: 'alive', statusCode: 200 },
      ]);

      ruleTester.run('validate-mdx-external-links', validateMdxExternalLinksRule, {
        valid: [
          {
            name: 'alive external links pass',
            filename: '/docs/test.mdx',
            code: 'See [Example](https://example.com) and [GitHub](https://github.com).',
          },
        ],
        invalid: [],
      });
    });
  });

  describe('dead URLs', () => {
    it('should report dead external links', () => {
      mockCheckerResults([{ url: 'https://dead.example.com/page', status: 'dead', statusCode: 404 }]);

      ruleTester.run('validate-mdx-external-links', validateMdxExternalLinksRule, {
        valid: [],
        invalid: [
          {
            name: 'dead link with 404',
            filename: '/docs/test.mdx',
            code: 'See [Dead](https://dead.example.com/page) for details.',
            errors: [
              {
                messageId: 'deadExternalLink',
                data: { url: 'https://dead.example.com/page', statusCode: '404' },
              },
            ],
          },
        ],
      });
    });

    it('should report dead link with 410 Gone', () => {
      mockCheckerResults([{ url: 'https://gone.example.com', status: 'dead', statusCode: 410 }]);

      ruleTester.run('validate-mdx-external-links', validateMdxExternalLinksRule, {
        valid: [],
        invalid: [
          {
            name: 'dead link with 410',
            filename: '/docs/test.mdx',
            code: 'See [Gone](https://gone.example.com).',
            errors: [
              {
                messageId: 'deadExternalLink',
                data: { url: 'https://gone.example.com', statusCode: '410' },
              },
            ],
          },
        ],
      });
    });
  });

  describe('unreachable URLs', () => {
    it('should report unreachable external links', () => {
      mockCheckerResults([{ url: 'https://unreachable.example.com', status: 'error', error: 'DNS resolution failed' }]);

      ruleTester.run('validate-mdx-external-links', validateMdxExternalLinksRule, {
        valid: [],
        invalid: [
          {
            name: 'unreachable link reports error',
            filename: '/docs/test.mdx',
            code: 'See [Unreachable](https://unreachable.example.com).',
            errors: [
              {
                messageId: 'unreachableExternalLink',
                data: { url: 'https://unreachable.example.com', error: 'DNS resolution failed' },
              },
            ],
          },
        ],
      });
    });
  });

  describe('mixed results', () => {
    it('should report only dead links when mixed with alive', () => {
      mockCheckerResults([
        { url: 'https://alive.com', status: 'alive', statusCode: 200 },
        { url: 'https://dead.com', status: 'dead', statusCode: 404 },
      ]);

      ruleTester.run('validate-mdx-external-links', validateMdxExternalLinksRule, {
        valid: [],
        invalid: [
          {
            name: 'only dead link reported',
            filename: '/docs/test.mdx',
            code: 'See [Alive](https://alive.com) and [Dead](https://dead.com).',
            errors: [
              {
                messageId: 'deadExternalLink',
                data: { url: 'https://dead.com', statusCode: '404' },
              },
            ],
          },
        ],
      });
    });
  });

  describe('subprocess failure', () => {
    it('should silently pass when subprocess crashes', () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('subprocess crashed');
      });

      ruleTester.run('validate-mdx-external-links', validateMdxExternalLinksRule, {
        valid: [
          {
            name: 'subprocess crash causes silent pass',
            filename: '/docs/test.mdx',
            code: 'See [Example](https://example.com).',
          },
        ],
        invalid: [],
      });
    });
  });
});
