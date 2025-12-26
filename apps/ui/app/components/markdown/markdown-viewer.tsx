import { Streamdown } from 'streamdown';
import type { ControlsConfig, StreamdownProps } from 'streamdown';
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
} & StreamdownProps;

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
function LinkComponent({ children, className, ...rest }: ComponentProps<'a'>): React.JSX.Element {
  return (
    <a
      {...rest}
      className={cn(className, 'underline underline-offset-3 transition-all duration-200 hover:underline-offset-4')}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}

export const defaultMarkdownComponents = {
  code: CodeComponent,
  a: LinkComponent,
} as const satisfies MarkdownViewerProps['components'];

export const defaultMarkdownControls = {
  // Disable built-in copy button (we have our own in CollapsibleCodeBlock)
  code: false,
  table: false,
} as const satisfies ControlsConfig;

export const MarkdownViewer = memo(function ({
  children,
  isStreaming = true,
  controls = defaultMarkdownControls,
  components,
}: MarkdownViewerProps): React.JSX.Element {
  // Memoize components object to prevent unnecessary re-renders
  const memoizedComponents = useMemo(
    () => ({
      ...defaultMarkdownComponents,
      ...components,
    }),
    [components],
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
        components={memoizedComponents}
        controls={controls}
        shikiTheme={['github-light', 'github-dark']}
      >
        {children}
      </Streamdown>
    </div>
  );
});
