import { useState, useMemo, memo } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockAction,
  CodeBlockContent,
  Pre,
} from '#components/code/code-block.js';
import { CopyButton } from '#components/copy-button.js';
import { Button } from '#components/ui/button.js';
import { cn } from '#utils/ui.utils.js';

type CollapsibleCodeBlockProps = {
  readonly language: string;
  readonly title?: string;
  readonly text: string;
  readonly collapsedLineCount?: number;
  readonly className?: string;
  readonly containerClassName?: string;
};

/**
 * A collapsible code block with syntax highlighting.
 * Shows a preview of the first N lines when collapsed, full code when expanded.
 *
 * Memoized to prevent unnecessary re-renders during streaming -
 * only re-renders when the actual text content or language changes.
 */
export const CollapsibleCodeBlock = memo(function ({
  language,
  title,
  text,
  collapsedLineCount = 4,
  className = '',
  containerClassName = '',
}: CollapsibleCodeBlockProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const lines = useMemo(() => text.split('\n'), [text]);
  const collapsedText = useMemo(() => lines.slice(0, collapsedLineCount).join('\n'), [lines, collapsedLineCount]);
  const shouldShowToggle = lines.length > collapsedLineCount;

  // Determine which text to display based on expanded state
  const displayText = isExpanded ? text : collapsedText;

  return (
    <CodeBlock className={containerClassName} variant="standard">
      <CodeBlockHeader variant="standard">
        <CodeBlockTitle variant="standard">{title}</CodeBlockTitle>
        <CodeBlockAction variant="standard">
          <CopyButton
            size="xs"
            className="h-6 **:data-[slot=label]:hidden @xs/code:**:data-[slot=label]:flex"
            getText={() => text}
          />
        </CodeBlockAction>
      </CodeBlockHeader>
      <div className={cn('relative leading-0', shouldShowToggle && !isExpanded ? 'max-h-32 overflow-y-auto' : '')}>
        <CodeBlockContent className="px-3">
          <Pre language={language} className={cn('text-xs', className)}>
            {displayText}
          </Pre>
        </CodeBlockContent>
        {shouldShowToggle ? (
          <Button
            size="xs"
            className="sticky bottom-0 mb-0 h-4 w-full rounded-none bg-neutral/10 text-center text-foreground/50 hover:bg-neutral/40"
            onClick={() => {
              setIsExpanded((previous) => !previous);
            }}
          >
            <ChevronDown className={cn('transition-transform', isExpanded ? 'rotate-x-180' : '')} />
          </Button>
        ) : null}
      </div>
    </CodeBlock>
  );
});
