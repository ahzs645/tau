import type { ComponentProps } from 'react';
import { InlineCode } from '#components/code/code-block.js';
import { extractTextFromChildren } from '#utils/react.utils.js';
import { CollapsibleCodeBlock } from '#components/ui/collapsible-code-block.js';

/**
 * Extracts the language from a className like "language-typescript".
 * Returns undefined if no language class is found.
 */
export function extractLanguageFromClassName(className: string | undefined): string | undefined {
  const match = /language-(\w+)/.exec(className ?? '');
  return match?.[1];
}

/**
 * Custom code component for markdown rendering.
 * Renders code blocks with syntax highlighting using CollapsibleCodeBlock,
 * and inline code using InlineCode.
 */
export function MarkdownCode({
  children,
  className,
  node: _node,
  ...rest
}: ComponentProps<'code'> & { readonly node?: unknown }): React.JSX.Element {
  const language = extractLanguageFromClassName(className);
  const text = extractTextFromChildren(children).replace(/\n$/, '');

  // Render as code block with syntax highlighting if language is detected
  if (language) {
    return <CollapsibleCodeBlock language={language} title={language} text={text} className={className ?? ''} />;
  }

  // Render as inline code
  return (
    <InlineCode {...rest} className={className}>
      {children}
    </InlineCode>
  );
}
