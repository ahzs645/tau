import { Streamdown } from 'streamdown';
import type { ControlsConfig, StreamdownProps } from 'streamdown';
import { memo, useMemo } from 'react';
import { cn } from '#utils/ui.utils.js';
import { MarkdownHyperlink } from '#components/markdown/markdown-hyperlink.js';
import { MarkdownCode } from '#components/markdown/markdown-code.js';

type MarkdownViewerProps = {
  readonly children: string;
  /**
   * Whether the content is currently streaming.
   * When true, uses streaming-optimized parsing.
   */
  readonly isStreaming?: boolean;
} & StreamdownProps;

export const defaultMarkdownComponents = {
  code: MarkdownCode,
  a: MarkdownHyperlink,
} as const satisfies MarkdownViewerProps['components'];

export const defaultMarkdownControls = {
  // Disable built-in copy button (we have our own in CollapsibleCodeBlock)
  code: false,
  table: false,
} as const satisfies ControlsConfig;

export const MarkdownViewer = memo(function ({
  children,
  isStreaming = false,
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
