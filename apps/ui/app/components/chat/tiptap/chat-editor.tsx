import { memo } from 'react';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { cn } from '#utils/ui.utils.js';
import { ContextSuggestionDropdown } from '#components/chat/tiptap/context-suggestion.js';
import { SlashCommandDropdown } from '#components/chat/tiptap/slash-command-suggestion.js';
import type {
  ContextSuggestionItem,
  SlashCommandItem,
  SuggestionPopupState,
} from '#components/chat/tiptap/suggestion-types.js';

/**
 * Tailwind overrides for TipTap's `.tiptap` editor element (no separate CSS file).
 * Uses `[&_selector]:utility` arbitrary variants following the dockview.tsx pattern.
 */
const tiptapTailwindOverrides = cn(
  '[&_.tiptap]:outline-none',
  '[&_.tiptap_p]:m-0',
  '[&_.tiptap_p.is-editor-empty:first-child::before]:[content:attr(data-placeholder)]',
  '[&_.tiptap_p.is-editor-empty:first-child::before]:float-left',
  '[&_.tiptap_p.is-editor-empty:first-child::before]:text-muted-foreground',
  '[&_.tiptap_p.is-editor-empty:first-child::before]:pointer-events-none',
  '[&_.tiptap_p.is-editor-empty:first-child::before]:h-0',
);

export type ChatEditorProps = {
  // oxlint-disable-next-line @typescript-eslint/no-restricted-types -- Tiptap returns null for uninitialized editor
  readonly editor: Editor | null;
  readonly className?: string;
  readonly contextSuggestionState: SuggestionPopupState<ContextSuggestionItem> | undefined;
  readonly slashCommandState: SuggestionPopupState<SlashCommandItem> | undefined;
  // oxlint-disable-next-line @typescript-eslint/no-restricted-types -- React ref object
  readonly contextKeydownRef: React.RefObject<((event: KeyboardEvent) => boolean) | undefined>;
  // oxlint-disable-next-line @typescript-eslint/no-restricted-types -- React ref object
  readonly slashKeydownRef: React.RefObject<((event: KeyboardEvent) => boolean) | undefined>;
};

export const ChatEditor = memo(function ChatEditor({
  editor,
  className,
  contextSuggestionState,
  slashCommandState,
  contextKeydownRef,
  slashKeydownRef,
}: ChatEditorProps): React.JSX.Element {
  return (
    <>
      <EditorContent
        editor={editor}
        className={cn(
          tiptapTailwindOverrides,
          'mb-10 size-full max-h-48 min-h-6 overflow-y-auto',
          'px-3 pb-3 pt-2',
          'text-sm',
          className,
        )}
      />

      {contextSuggestionState ? (
        <ContextSuggestionDropdown state={contextSuggestionState} keydownHandlerRef={contextKeydownRef} />
      ) : undefined}

      {slashCommandState ? (
        <SlashCommandDropdown state={slashCommandState} keydownHandlerRef={slashKeydownRef} />
      ) : undefined}
    </>
  );
});
