import { Editor } from '@monaco-editor/react';
import type { EditorProps } from '@monaco-editor/react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { CompletionRegistration } from 'monacopilot';
import type * as Monaco from 'monaco-editor';
import { cn } from '#utils/ui.utils.js';
import { configureMonaco, registerCompletions } from '#lib/monaco.js';
import { useIsMobile } from '#hooks/use-mobile.js';
import { Theme, useTheme } from '#hooks/use-theme.js';

type CodeEditorProperties = EditorProps & {
  readonly onChange: (value: string) => void;
};

// Cap synchronous tokenization to avoid blocking the main thread on very large
// files. For typical engineering code files (< 500 lines) this is < 5 ms.
const maxForceTokenizeLines = 5000;

await configureMonaco();

export function CodeEditor({ className, ...rest }: CodeEditorProperties): React.JSX.Element {
  const { theme } = useTheme();
  const completionRef = useRef<CompletionRegistration | undefined>(null);
  const isMobile = useIsMobile();

  const handleMount = useCallback((editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => {
    completionRef.current = registerCompletions(editor, monaco);

    // Force immediate tokenization of visible lines.
    // Monaco schedules background tokenization via requestIdleCallback, which
    // can be indefinitely delayed during initial page load when the browser is
    // busy with layout, React hydration, and Dockview initialization. This
    // causes code to appear without syntax highlighting until the user scrolls.
    // Forcing synchronous tokenization here ensures highlighting is visible
    // from the first render.
    const model = editor.getModel();
    if (model) {
      const targetLine = Math.min(model.getLineCount(), maxForceTokenizeLines);
      // Monaco's tokenization.forceTokenization is a stable internal API used
      // extensively by its own features (colorizer, auto-indent, comment commands,
      // etc.) but not exposed in public type declarations.
      const tokenization = model as unknown as {
        tokenization?: { forceTokenization?: (lineNumber: number) => void };
      };
      tokenization.tokenization?.forceTokenization?.(targetLine);
    }
  }, []);

  useEffect(() => {
    return () => {
      completionRef.current?.deregister();
    };
  }, []);

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
        // Use position:fixed for overflow widgets (hover, suggest, parameter
        // hints) so they render above all content. Dockview's CSS containment
        // (contain, transform, will-change) is overridden in tau-dockview.css
        // to ensure position:fixed is relative to the viewport, not the panel.
        fixedOverflowWidgets: true,
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
