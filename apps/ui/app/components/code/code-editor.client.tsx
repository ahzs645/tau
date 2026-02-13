import { Editor, useMonaco } from '@monaco-editor/react';
import type { EditorProps } from '@monaco-editor/react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { shikiToMonaco } from '@shikijs/monaco';
import type { CompletionRegistration } from 'monacopilot';
import type * as Monaco from 'monaco-editor';
import { cn } from '#utils/ui.utils.js';
import { highlighter } from '#lib/shiki.js';
import { configureMonaco, registerCompletions } from '#lib/monaco.js';
import { useIsMobile } from '#hooks/use-mobile.js';
import { Theme, useTheme } from '#hooks/use-theme.js';

type CodeEditorProperties = EditorProps & {
  readonly onChange: (value: string) => void;
};

await configureMonaco();

/**
 * Create a shared overflow widgets container for all Monaco editors.
 *
 * Monaco's hover tooltip, suggest widget, and parameter hints use
 * `position: fixed` when `fixedOverflowWidgets` is enabled. Inside
 * Dockview panels, CSS `transform: translate3d(0,0,0)` and
 * `contain: layout paint` on ancestor elements create new containing
 * blocks that break fixed positioning -- widgets get clipped by
 * `overflow: hidden` on the group view instead of rendering above
 * everything.
 *
 * Placing the overflow container on `document.body` (outside the
 * Dockview DOM hierarchy) avoids all CSS containment issues. Each
 * Monaco editor appends its own child `overflowingContentWidgets`
 * container inside this shared node. Combined with
 * `fixedOverflowWidgets: true`, widgets use viewport coordinates and
 * render above all panes -- matching VSCode's multi-diff editor
 * pattern (see `multiDiffEditorWidgetImpl.ts` line 78).
 */
function createOverflowWidgetsDomNode(): HTMLDivElement {
  const node = document.createElement('div');
  node.className = 'monaco-editor';
  node.style.cssText = 'position:fixed;top:0;left:0;overflow:visible;z-index:50;pointer-events:none;';
  document.body.append(node);
  return node;
}

const overflowWidgetsDomNode = createOverflowWidgetsDomNode();

export function CodeEditor({ className, ...rest }: CodeEditorProperties): React.JSX.Element {
  const { theme } = useTheme();
  const completionRef = useRef<CompletionRegistration | undefined>(null);
  const isMobile = useIsMobile();

  const handleMount = useCallback((editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => {
    completionRef.current = registerCompletions(editor, monaco);
  }, []);

  useEffect(() => {
    return () => {
      completionRef.current?.deregister();
    };
  }, []);

  const monaco = useMonaco();

  useEffect(() => {
    if (monaco) {
      shikiToMonaco(highlighter, monaco);
    }
  }, [monaco]);

  // Sync the shared overflow widgets container theme class so hover
  // tooltips, suggest widgets, and parameter hints are styled correctly.
  useEffect(() => {
    overflowWidgetsDomNode.className = `monaco-editor ${theme === Theme.DARK ? 'vs-dark' : 'vs'}`;
  }, [theme]);

  const options = useMemo(
    () =>
      ({
        fontSize: isMobile ? 16 : 14,
        fontFamily: 'var(--font-mono)',
        tabSize: 2,
        minimap: { enabled: false },
        // Explicitly configure line numbers
        lineNumbers: 'on',
        lineNumbersMinChars: 4,
        renderLineHighlight: 'line',
        renderLineHighlightOnlyWhenFocus: false,
        // Disable horizontal scroll beyond last line
        scrollBeyondLastColumn: 1,
        // Disable vertical scroll beyond last line
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        // Render overflow widgets (hover, suggest, parameter hints) in a shared
        // container on document.body so they escape Dockview's CSS containment.
        // fixedOverflowWidgets uses position:fixed with viewport coordinates;
        // overflowWidgetsDomNode places the container outside the Dockview hierarchy.
        fixedOverflowWidgets: true,
        overflowWidgetsDomNode,
        // Enable smooth cursor animation when typing and keying left/right/up/down
        cursorSmoothCaretAnimation: 'on',
        // Disable the sticky scrolling which displays the parent closure at the top of the editor for better performance.
        stickyScroll: {
          enabled: false,
        },
        // Configure gutter and margin properly
        glyphMargin: false,
        folding: true,
        // Custom scrollbar styling to match global scrollbar styles
        scrollbar: {
          // Applying to ensure that other elements that use the scrollbar
          // dimensions are styled correctly.
          verticalScrollbarSize: 14,
          horizontalScrollbarSize: 14,
          verticalSliderSize: 14,
          horizontalSliderSize: 14,
          // Ensure browser back and forward navigation scroll does not take effect,
          // as it causes janky editor behavior resulting in poor UX.
          alwaysConsumeMouseWheel: true,
        },
        // Intellisense
        suggest: {
          localityBonus: true,
          showStatusBar: true,
          preview: true,
        },
        parameterHints: {
          enabled: true,
          // Controls whether the parameter hints menu cycles or closes when reaching the end of the list.
          cycle: true,
        },
        automaticLayout: true,
        // Word-based suggestions are redundant for typed languages
        wordBasedSuggestions: 'off',
      }) as const satisfies Monaco.editor.IStandaloneEditorConstructionOptions,
    [isMobile],
  );

  const classNames = useMemo(
    () =>
      cn(
        // Target Monaco editor elements with Tailwind's nested syntax
        // Override the background color of the Monaco editor
        '[&_.monaco-editor]:![--vscode-editor-background:var(--background)]',
        '[&_.monaco-editor]:![--vscode-editorStickyScroll-background:var(--background)]',
        '[&_.monaco-editor]:![--vscode-breadcrumb-background:transparent]',
        '[&_.monaco-editor]:![--vscode-multiDiffEditor-background:var(--background)]',
        '[&_.monaco-editor]:![--vscode-editorMarkerNavigation-background:var(--background)]',
        '[&_.monaco-editor]:![--vscode-editorGutter-background:var(--background)]',
        // Hide the redundant text area cover element
        '[&_.monaco-editor-background.textAreaCover.line-numbers]:!hidden',
        // Disable ::before pseudo-elements on line numbers
        '[&_.line-numbers::before]:!hidden',
        // Existing scrollbar styles
        '[&_.monaco-scrollable-element_>_.scrollbar]:!bg-(--scrollbar-track)',
        '[&_.monaco-scrollable-element_>_.scrollbar_>_.slider]:!bg-(--scrollbar-thumb)/80',
        className,
      ),
    [className],
  );

  return (
    <Editor
      keepCurrentModel
      className={classNames}
      theme={theme === Theme.DARK ? 'github-dark' : 'github-light'}
      wrapperProps={{
        className: 'editor-container',
        style: { height: '100%' },
      }}
      options={options}
      onMount={handleMount}
      {...rest}
    />
  );
}
