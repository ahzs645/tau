import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { isExternalLink, MarkdownHyperlink } from '#components/markdown/markdown-hyperlink.js';

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

describe('MarkdownHyperlink', () => {
  describe('external links', () => {
    it('opens in new tab for https:// links', () => {
      render(<MarkdownHyperlink href="https://example.com">External Link</MarkdownHyperlink>);

      const link = screen.getByRole('link', { name: 'External Link' });
      expect(link).toHaveAttribute('target', '_blank');
    });

    it('opens in new tab for http:// links', () => {
      render(<MarkdownHyperlink href="http://example.com">External Link</MarkdownHyperlink>);

      const link = screen.getByRole('link', { name: 'External Link' });
      expect(link).toHaveAttribute('target', '_blank');
    });

    it('sets rel="noopener noreferrer" for external links', () => {
      render(<MarkdownHyperlink href="https://example.com">External Link</MarkdownHyperlink>);

      const link = screen.getByRole('link', { name: 'External Link' });
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });

  describe('internal links', () => {
    it('opens in same tab for relative paths', () => {
      render(<MarkdownHyperlink href="/legal/privacy">Internal Link</MarkdownHyperlink>);

      const link = screen.getByRole('link', { name: 'Internal Link' });
      expect(link).not.toHaveAttribute('target');
    });

    it('opens in same tab for anchor links', () => {
      render(<MarkdownHyperlink href="#section-1">Anchor Link</MarkdownHyperlink>);

      const link = screen.getByRole('link', { name: 'Anchor Link' });
      expect(link).not.toHaveAttribute('target');
    });

    it('does not set rel for internal links', () => {
      render(<MarkdownHyperlink href="/legal/privacy">Internal Link</MarkdownHyperlink>);

      const link = screen.getByRole('link', { name: 'Internal Link' });
      expect(link).not.toHaveAttribute('rel');
    });
  });

  describe('styling', () => {
    it('applies underline class', () => {
      render(<MarkdownHyperlink href="/test">Link</MarkdownHyperlink>);

      const link = screen.getByRole('link', { name: 'Link' });
      expect(link).toHaveClass('underline');
    });

    it('applies underline-offset-3 class', () => {
      render(<MarkdownHyperlink href="/test">Link</MarkdownHyperlink>);

      const link = screen.getByRole('link', { name: 'Link' });
      expect(link).toHaveClass('underline-offset-3');
    });

    it('applies transition classes', () => {
      render(<MarkdownHyperlink href="/test">Link</MarkdownHyperlink>);

      const link = screen.getByRole('link', { name: 'Link' });
      expect(link).toHaveClass('transition-all', 'duration-200');
    });

    it('applies additional className from props', () => {
      render(
        <MarkdownHyperlink href="/test" className="custom-class">
          Link
        </MarkdownHyperlink>,
      );

      const link = screen.getByRole('link', { name: 'Link' });
      expect(link).toHaveClass('custom-class');
    });
  });

  describe('attributes', () => {
    it('sets href attribute', () => {
      render(<MarkdownHyperlink href="/legal/privacy">Link</MarkdownHyperlink>);

      const link = screen.getByRole('link', { name: 'Link' });
      expect(link).toHaveAttribute('href', '/legal/privacy');
    });

    it('renders children', () => {
      render(<MarkdownHyperlink href="/test">Click me</MarkdownHyperlink>);

      expect(screen.getByText('Click me')).toBeInTheDocument();
    });

    it('passes through additional props', () => {
      render(
        <MarkdownHyperlink href="/test" data-testid="custom-link">
          Link
        </MarkdownHyperlink>,
      );

      expect(screen.getByTestId('custom-link')).toBeInTheDocument();
    });
  });
});
