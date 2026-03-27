import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { FileEntry } from '@taucad/types';
import type { Chat } from '@taucad/chat';
import { AtReferenceChip } from '#components/chat/at-reference-chip.js';
import { AtReferenceProvider } from '#components/chat/at-reference-context.js';

vi.mock('#components/files/file-link.js', () => ({
  FileLink: ({ children, path }: { children: React.ReactNode; path: string }) => (
    <a data-testid='file-link' data-path={path}>
      {children}
    </a>
  ),
}));

vi.mock('#hooks/use-project.js', () => ({
  useProject: () => ({
    editorRef: { send: vi.fn() },
    projectId: 'test-project',
  }),
}));

function createFileTree(entries: Array<[string, Partial<FileEntry>]>): Map<string, FileEntry> {
  return new Map(
    entries.map(([path, partial]) => [
      path,
      {
        path,
        name: partial.name ?? path.split('/').pop()!,
        type: partial.type ?? 'file',
        size: 0,
        isLoaded: true,
        mtimeMs: 0,
        ...partial,
      },
    ]),
  );
}

function createChats(items: Array<{ id: string; name: string }>): Chat[] {
  return items.map((c) => ({
    id: c.id,
    name: c.name,
    resourceId: 'r1',
    messages: [],
    createdAt: 0,
    updatedAt: 0,
  }));
}

function renderChip(path: string, fileTree: Map<string, FileEntry> = new Map(), chats: Chat[] = []) {
  return render(
    <AtReferenceProvider fileTree={fileTree} chats={chats}>
      <AtReferenceChip data-at-reference={path} />
    </AtReferenceProvider>,
  );
}

describe('AtReferenceChip', () => {
  it('should render file chip with FileLink for existing file', () => {
    const fileTree = createFileTree([['src/app.ts', { name: 'app.ts', type: 'file' }]]);

    renderChip('src/app.ts', fileTree);

    expect(screen.getByText('app.ts')).toBeInTheDocument();
    expect(screen.getByTestId('file-link')).toHaveAttribute('data-path', 'src/app.ts');
  });

  it('should render folder chip with FileLink for existing folder', () => {
    const fileTree = createFileTree([['src/components', { name: 'components', type: 'dir' }]]);

    renderChip('src/components', fileTree);

    expect(screen.getByText('components')).toBeInTheDocument();
    expect(screen.getByTestId('file-link')).toBeInTheDocument();
  });

  it('should render chat chip for valid transcript path', () => {
    const chats = createChats([{ id: 'chat-123', name: 'Design Discussion' }]);

    renderChip('.tau/transcripts/chat-123.jsonl', new Map(), chats);

    expect(screen.getByText('Design Discussion')).toBeInTheDocument();
  });

  it('should render plain text for unknown transcript path', () => {
    renderChip('.tau/transcripts/missing-chat.jsonl');

    expect(screen.getByText('@.tau/transcripts/missing-chat.jsonl')).toBeInTheDocument();
    expect(screen.queryByTestId('file-link')).not.toBeInTheDocument();
  });

  it('should render plain text for unknown file path', () => {
    renderChip('does/not/exist.ts');

    expect(screen.getByText('@does/not/exist.ts')).toBeInTheDocument();
    expect(screen.queryByTestId('file-link')).not.toBeInTheDocument();
  });

  it('should not pass onRemove to ContextChip (read-only)', () => {
    const fileTree = createFileTree([['src/app.ts', { name: 'app.ts', type: 'file' }]]);

    renderChip('src/app.ts', fileTree);

    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('should render fallback mark when no data-at-reference attribute', () => {
    const { container } = render(
      <AtReferenceProvider fileTree={new Map()} chats={[]}>
        <AtReferenceChip>highlighted text</AtReferenceChip>
      </AtReferenceProvider>,
    );

    expect(container.querySelector('mark')).toBeInTheDocument();
    expect(screen.getByText('highlighted text')).toBeInTheDocument();
  });

  it('should render skill chip when data-slash-command is set', () => {
    render(
      <AtReferenceProvider fileTree={new Map()} chats={[]}>
        <AtReferenceChip data-slash-command='create-policy' />
      </AtReferenceProvider>,
    );

    expect(screen.getByText('/create-policy')).toBeInTheDocument();
    expect(screen.queryByTestId('file-link')).not.toBeInTheDocument();
  });

  it('should render fallback mark when neither data attribute is present', () => {
    const { container } = render(
      <AtReferenceProvider fileTree={new Map()} chats={[]}>
        <AtReferenceChip>some text</AtReferenceChip>
      </AtReferenceProvider>,
    );

    expect(container.querySelector('mark')).toBeInTheDocument();
    expect(screen.getByText('some text')).toBeInTheDocument();
  });
});
