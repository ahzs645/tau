import { Streamdown } from 'streamdown';
import type { ComponentProps } from 'react';
import { memo, useMemo } from 'react';
import { InlineCode } from '#components/code/code-block.js';
import { cn } from '#utils/ui.utils.js';
import { extractTextFromChildren } from '#utils/react.utils.js';
import { CollapsibleCodeBlock } from '#components/markdown/collapsible-code-block.js';

type MarkdownViewerProps = {
  readonly children: string;
  /**
   * Whether the content is currently streaming.
   * When true, uses streaming-optimized parsing.
   */
  readonly isStreaming?: boolean;
};

// Custom code component that uses our shiki highlighter with custom language support
function CodeComponent({
  children,
  className,
  node: _node,
  ...rest
}: ComponentProps<'code'> & { readonly node?: unknown }): React.JSX.Element {
  // Check if this is a code block (has language class) or inline code
  const match = /language-(\w+)/.exec(className ?? '');
  const text = extractTextFromChildren(children).replace(/\n$/, '');

  if (match?.[1]) {
    const language = match[1];
    return <CollapsibleCodeBlock language={language} title={language} text={text} className={className ?? ''} />;
  }

  // Render as inline code
  return (
    <InlineCode {...rest} className={className}>
      {children}
    </InlineCode>
  );
}

// Custom link component that opens in new tab
function LinkComponent({ children, ...rest }: ComponentProps<'a'>): React.JSX.Element {
  return (
    <a {...rest} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export const MarkdownViewer = memo(function ({ children, isStreaming = true }: MarkdownViewerProps): React.JSX.Element {
  // Memoize components object to prevent unnecessary re-renders
  const components = useMemo(
    () => ({
      code: CodeComponent,
      a: LinkComponent,
    }),
    [],
  );

  return (
    <div
      className={cn(
        //
        'w-full max-w-full text-sm text-foreground',
        'overflow-wrap-anywhere wrap-break-word hyphens-auto',
      )}
    >
      <Streamdown
        mode={isStreaming ? 'streaming' : 'static'}
        components={components}
        controls={{ code: false }} // Disable built-in copy button (we have our own in CollapsibleCodeBlock)
        shikiTheme={['github-light', 'github-dark']}
      >
        {children}
      </Streamdown>
    </div>
  );
});
