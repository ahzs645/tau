import type { ComponentProps } from 'react';
import { ContextChip } from '#components/chat/context-chip.js';
import { FileLink } from '#components/files/file-link.js';
import { useAtReferenceContext } from '#components/chat/at-reference-context.js';
import { resolveAtReference } from '#utils/at-reference.utils.js';

type AtReferenceChipProps = ComponentProps<'mark'> & {
  readonly 'data-at-reference'?: string;
  readonly 'data-slash-command'?: string;
};

/**
 * Renders `@path` and `/command` references as visual chips in chat messages.
 * Resolves paths against the file tree and chats for display.
 *
 * Registered as the `mark` component override in `MarkdownViewerChat`.
 * `rehypeAtReferences` emits `<mark>` elements with either
 * `data-at-reference` or `data-slash-command` attributes.
 */
export function AtReferenceChip(props: AtReferenceChipProps): React.JSX.Element {
  const slashCommand = props['data-slash-command'];
  if (slashCommand) {
    return <ContextChip label={`/${slashCommand}`} chipType='skill' />;
  }

  const path = props['data-at-reference'];
  if (!path) {
    return <mark {...props} />;
  }

  return <ResolvedChip path={path} />;
}

function ResolvedChip({ path }: { readonly path: string }): React.JSX.Element {
  const { fileTree, chatsById } = useAtReferenceContext();
  const resolved = resolveAtReference(path, fileTree, chatsById);

  if (!resolved) {
    return <span>{`@${path}`}</span>;
  }

  return (
    <FileLink path={path} asChild>
      <ContextChip label={resolved.displayName} chipType={resolved.chipType} isInteractive />
    </FileLink>
  );
}
