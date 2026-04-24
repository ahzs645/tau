import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { isExternalLink, MarkdownHyperlink, resolveRelativeHref } from '#components/markdown/markdown-hyperlink.js';

describe('isExternalLink', () => {
  it('returns true for http:// URLs', () => {
    expect(isExternalLink('http://example.com')).toBe(true);
  });

  it('returns true for https:// URLs', () => {
    expect(isExternalLink('https://example.com')).toBe(true);
  });

  it('returns false for relative paths', () => {
    expect(isExternalLink('/legal/privacy')).toBe(false);
  });

  it('returns false for anchor links', () => {
    expect(isExternalLink('#section-1')).toBe(false);
  });

  it('returns false for relative paths with anchors', () => {
    expect(isExternalLink('/legal/cookies#preferences')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isExternalLink(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isExternalLink('')).toBe(false);
  });

  it('returns false for mailto: links', () => {
    expect(isExternalLink('mailto:test@example.com')).toBe(false);
  });

  it('returns false for tel: links', () => {
    expect(isExternalLink('tel:+1234567890')).toBe(false);
  });
});

describe('resolveRelativeHref', () => {
  it('returns absolute paths unchanged', () => {
    expect(resolveRelativeHref('/docs/getting-started/quick-start', '/docs/guides/live-rendering')).toBe(
      '/docs/getting-started/quick-start',
    );
  });

  it('returns anchor-only links unchanged', () => {
    expect(resolveRelativeHref('#section', '/docs/guides/live-rendering')).toBe('#section');
  });

  it('returns scheme links unchanged', () => {
    expect(resolveRelativeHref('mailto:hello@example.com', '/docs/guides/live-rendering')).toBe(
      'mailto:hello@example.com',
    );
    expect(resolveRelativeHref('https://example.com/foo', '/docs/guides/live-rendering')).toBe(
      'https://example.com/foo',
    );
  });

  it('resolves ../ from a leaf URL via standard URL semantics (RFC 3986)', () => {
    // Regression: React Router's `relative='path'` would have produced
    // /docs/guides/getting-started/quick-start (only popping `live-rendering`),
    // breaking every cross-directory MDX link.
    expect(resolveRelativeHref('../getting-started/quick-start', '/docs/guides/live-rendering')).toBe(
      '/docs/getting-started/quick-start',
    );
  });

  it('resolves ./sibling from a leaf URL', () => {
    expect(resolveRelativeHref('./embedding-in-a-host', '/docs/guides/live-rendering')).toBe(
      '/docs/guides/embedding-in-a-host',
    );
  });

  it('resolves a bare sibling path from a leaf URL', () => {
    expect(resolveRelativeHref('embedding-in-a-host', '/docs/guides/live-rendering')).toBe(
      '/docs/guides/embedding-in-a-host',
    );
  });

  it('preserves hash and search when resolving', () => {
    expect(resolveRelativeHref('../api/client#methods', '/docs/guides/live-rendering')).toBe(
      '/docs/api/client#methods',
    );
    expect(resolveRelativeHref('./error-handling?q=1#x', '/docs/guides/live-rendering')).toBe(
      '/docs/guides/error-handling?q=1#x',
    );
  });

  it('returns empty string unchanged', () => {
    expect(resolveRelativeHref('', '/docs/guides/live-rendering')).toBe('');
  });
});

describe('MarkdownHyperlink', () => {
  describe('external links', () => {
    it('opens in new tab for https:// links', () => {
      render(
        <MemoryRouter>
          <MarkdownHyperlink href='https://example.com'>External Link</MarkdownHyperlink>
        </MemoryRouter>,
      );

      const link = screen.getByRole('link', { name: 'External Link' });
      expect(link).toHaveAttribute('target', '_blank');
    });

    it('opens in new tab for http:// links', () => {
      render(
        <MemoryRouter>
          <MarkdownHyperlink href='http://example.com'>External Link</MarkdownHyperlink>
        </MemoryRouter>,
      );

      const link = screen.getByRole('link', { name: 'External Link' });
      expect(link).toHaveAttribute('target', '_blank');
    });

    it('sets rel="noopener noreferrer" for external links', () => {
      render(
        <MemoryRouter>
          <MarkdownHyperlink href='https://example.com'>External Link</MarkdownHyperlink>
        </MemoryRouter>,
      );

      const link = screen.getByRole('link', { name: 'External Link' });
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });

  describe('internal links', () => {
    it('opens in same tab for relative paths', () => {
      render(
        <MemoryRouter>
          <MarkdownHyperlink href='/legal/privacy'>Internal Link</MarkdownHyperlink>
        </MemoryRouter>,
      );

      const link = screen.getByRole('link', { name: 'Internal Link' });
      expect(link).not.toHaveAttribute('target');
    });

    it('opens in same tab for anchor links', () => {
      render(
        <MemoryRouter>
          <MarkdownHyperlink href='#section-1'>Anchor Link</MarkdownHyperlink>
        </MemoryRouter>,
      );

      const link = screen.getByRole('link', { name: 'Anchor Link' });
      expect(link).not.toHaveAttribute('target');
    });

    it('does not set rel for internal links', () => {
      render(
        <MemoryRouter>
          <MarkdownHyperlink href='/legal/privacy'>Internal Link</MarkdownHyperlink>
        </MemoryRouter>,
      );

      const link = screen.getByRole('link', { name: 'Internal Link' });
      expect(link).not.toHaveAttribute('rel');
    });
  });

  describe('styling', () => {
    it('applies underline class', () => {
      render(
        <MemoryRouter>
          <MarkdownHyperlink href='/test'>Link</MarkdownHyperlink>
        </MemoryRouter>,
      );

      const link = screen.getByRole('link', { name: 'Link' });
      expect(link).toHaveClass('underline');
    });

    it('applies underline-offset-3 class', () => {
      render(
        <MemoryRouter>
          <MarkdownHyperlink href='/test'>Link</MarkdownHyperlink>
        </MemoryRouter>,
      );

      const link = screen.getByRole('link', { name: 'Link' });
      expect(link).toHaveClass('underline-offset-3');
    });

    it('applies transition classes', () => {
      render(
        <MemoryRouter>
          <MarkdownHyperlink href='/test'>Link</MarkdownHyperlink>
        </MemoryRouter>,
      );

      const link = screen.getByRole('link', { name: 'Link' });
      expect(link).toHaveClass('transition-all', 'duration-200');
    });

    it('applies additional className from props', () => {
      render(
        <MemoryRouter>
          <MarkdownHyperlink href='/test' className='custom-class'>
            Link
          </MarkdownHyperlink>
        </MemoryRouter>,
      );

      const link = screen.getByRole('link', { name: 'Link' });
      expect(link).toHaveClass('custom-class');
    });
  });

  describe('attributes', () => {
    it('sets href attribute', () => {
      render(
        <MemoryRouter>
          <MarkdownHyperlink href='/legal/privacy'>Link</MarkdownHyperlink>
        </MemoryRouter>,
      );

      const link = screen.getByRole('link', { name: 'Link' });
      expect(link).toHaveAttribute('href', '/legal/privacy');
    });

    it('rewrites a relative ../ href into an absolute URL relative to the current pathname', () => {
      render(
        <MemoryRouter initialEntries={['/docs/guides/live-rendering']}>
          <MarkdownHyperlink href='../getting-started/quick-start'>Quick Start</MarkdownHyperlink>
        </MemoryRouter>,
      );

      const link = screen.getByRole('link', { name: 'Quick Start' });
      expect(link).toHaveAttribute('href', '/docs/getting-started/quick-start');
    });

    it('rewrites a ./sibling href into an absolute URL within the current directory', () => {
      render(
        <MemoryRouter initialEntries={['/docs/guides/live-rendering']}>
          <MarkdownHyperlink href='./embedding-in-a-host'>Embedding</MarkdownHyperlink>
        </MemoryRouter>,
      );

      const link = screen.getByRole('link', { name: 'Embedding' });
      expect(link).toHaveAttribute('href', '/docs/guides/embedding-in-a-host');
    });

    it('renders children', () => {
      render(
        <MemoryRouter>
          <MarkdownHyperlink href='/test'>Click me</MarkdownHyperlink>
        </MemoryRouter>,
      );

      expect(screen.getByText('Click me')).toBeInTheDocument();
    });

    it('passes through additional props', () => {
      render(
        <MemoryRouter>
          <MarkdownHyperlink href='/test' data-testid='custom-link'>
            Link
          </MarkdownHyperlink>
        </MemoryRouter>,
      );

      expect(screen.getByTestId('custom-link')).toBeInTheDocument();
    });
  });
});
