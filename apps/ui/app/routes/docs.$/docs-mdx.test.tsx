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

    it('renders fenced code block children as bare <code> without InlineCode chrome', () => {
      const Code = getMdxCode();
      const { container } = render(
        <Code>
          <span className='line' data-testid='shiki-line'>
            <span>hi</span>
          </span>
        </Code>,
      );
      expect(document.querySelector('[data-slot="inline-code"]')).toBeNull();
      const code = container.querySelector('code');
      expect(code).not.toBeNull();
      expect(code).not.toHaveClass('rounded-xs', 'border', 'bg-neutral/10');
      expect(screen.getByTestId('shiki-line')).toBeInTheDocument();
    });

    it('wraps inline shiki ({:lang}) children in InlineCode chrome', () => {
      const Code = getMdxCode();
      render(
        <Code className='shiki'>
          <span data-testid='shiki-token'>useState</span>
        </Code>,
      );
      const element = document.querySelector('[data-slot="inline-code"]');
      expect(element).not.toBeNull();
      expect(element).toHaveClass('shiki');
      expect(screen.getByTestId('shiki-token')).toBeInTheDocument();
    });
  });
});
