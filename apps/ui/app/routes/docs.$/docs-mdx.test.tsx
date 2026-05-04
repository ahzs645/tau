// @vitest-environment jsdom
import type { ComponentProps, ElementType, ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { getMdxComponents } from '#routes/docs.$/docs-mdx.js';

type MdxCodeProps = ComponentProps<'code'> & { readonly children?: ReactNode };

const getMdxCode = (): ElementType<MdxCodeProps> => {
  const raw = getMdxComponents()['code'];
  if (typeof raw !== 'function') {
    throw new TypeError('Expected getMdxComponents()["code"] to be a function');
  }
  return raw as ElementType<MdxCodeProps>;
};

describe('getMdxComponents', () => {
  describe('code', () => {
    it('wraps plain string inline code in InlineCode chrome', () => {
      const Code = getMdxCode();
      render(<Code className=''>plain</Code>);
      const element = document.querySelector('[data-slot="inline-code"]');
      expect(element).not.toBeNull();
      expect(element).toHaveTextContent('plain');
      expect(element).not.toHaveClass('flex', 'flex-col');
    });

    it('wraps Shiki-highlighted children in InlineCode chrome', () => {
      const Code = getMdxCode();
      render(
        <Code className='shiki shiki-themes github-light github-dark'>
          <span className='line' data-testid='shiki-line'>
            <span>hi</span>
          </span>
        </Code>,
      );
      const element = document.querySelector('[data-slot="inline-code"]');
      expect(element).not.toBeNull();
      expect(element).toHaveClass('shiki');
      expect(screen.getByTestId('shiki-line')).toBeInTheDocument();
      expect(element).not.toHaveClass('flex', 'flex-col');
    });
  });
});
