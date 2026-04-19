import { useState, useEffect } from 'react';
import { useShikiHighlighter } from 'react-shiki/core';
import type { HighlighterCore } from 'shiki/core';
import type { ClassValue } from 'clsx';
import type { CodeLanguage } from '@taucad/types';
import { cn } from '#utils/ui.utils.js';
import { getHighlighter } from '#lib/shiki.lib.js';
import { useTheme } from '#hooks/use-theme.js';

type CodeViewerProps = {
  readonly text: string;
  readonly language: CodeLanguage;
  readonly className?: ClassValue;
};

const codeViewerClassName =
  'not-fumadocs-codeblock text-sm [&_pre]:m-0 [&_pre]:my-0 [&_pre]:bg-transparent! [&_pre]:p-0 [&_pre]:leading-[1.45]';

export function CodeViewer({ text, language, className }: CodeViewerProps): React.JSX.Element {
  const { theme } = useTheme();
  const [highlighter, setHighlighter] = useState<HighlighterCore | undefined>();

  useEffect(() => {
    const loadHighlighter = async () => {
      setHighlighter(await getHighlighter());
    };
    void loadHighlighter();
  }, []);

  if (!highlighter) {
    return (
      <div className={cn(codeViewerClassName, className)}>
        <pre className='m-0 bg-transparent p-0 leading-[1.45]'>
          <code>{text}</code>
        </pre>
      </div>
    );
  }

  return (
    <HighlightedCode text={text} language={language} theme={theme} highlighter={highlighter} className={className} />
  );
}

function HighlightedCode({
  text,
  language,
  theme,
  highlighter,
  className,
}: {
  text: string;
  language: CodeLanguage;
  theme: string;
  highlighter: HighlighterCore;
  className?: ClassValue;
}): React.JSX.Element {
  const highlightedCode = useShikiHighlighter(text, language, `github-${theme}`, { delay: 150, highlighter });

  return <div className={cn(codeViewerClassName, className)}>{highlightedCode}</div>;
}
