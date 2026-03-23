import { CodeEditor } from '#components/code/code-editor.client.js';
import { Loader } from '#components/ui/loader.js';
import { ChatEditorBreadcrumbs } from '#routes/projects_.$id/chat-editor-breadcrumbs.js';
import type { ChatEditorViewerProps } from '#routes/projects_.$id/chat-editor-viewer.types.js';
import { createMonacoPath } from '#routes/projects_.$id/chat-editor-viewer.types.js';

export function ChatEditorCodeViewer({
  filePath,
  content,
  language,
  onChange,
  onValidate,
}: ChatEditorViewerProps): React.JSX.Element {
  return (
    <>
      <ChatEditorBreadcrumbs filePath={filePath} />
      <CodeEditor
        loading={<Loader className='size-20 stroke-1 text-primary' />}
        className='h-full bg-background'
        defaultLanguage={language}
        defaultValue={content}
        path={createMonacoPath(filePath)}
        onChange={onChange}
        onValidate={onValidate}
      />
    </>
  );
}
