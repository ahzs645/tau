import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IDockviewPanelProps } from 'dockview-react';
import type { FileContentResult } from '#lib/file-content-service.js';

const mockResolve = vi.fn();
const mockWriteFile = vi.fn();

const mockUseFileContent = vi.fn<(path: string | undefined) => FileContentResult>();

vi.mock('#hooks/use-file-content.js', () => ({
  useFileContent: (path: string | undefined) => mockUseFileContent(path),
}));

vi.mock('#hooks/use-file-manager.js', () => ({
  useFileManager: () => ({
    contentService: { resolve: mockResolve },
    writeFile: mockWriteFile,
  }),
}));

vi.mock('#hooks/use-project.js', () => ({
  useProject: () => ({
    editorRef: { send: vi.fn() },
    compilationUnits: new Map(),
    mainEntryFile: 'main.ts',
  }),
}));

vi.mock('#hooks/use-monaco-model-service.js', () => ({
  useMonacoServices: () => ({ modelService: undefined, markerService: undefined }),
}));

vi.mock('#hooks/use-kernel-diagnostics.js', () => ({
  useKernelDiagnostics: () => ({ handleValidate: vi.fn() }),
}));

vi.mock('#flags/use-feature.js', () => ({
  useFeature: () => false,
}));

vi.mock('@monaco-editor/react', () => ({
  useMonaco: () => undefined,
}));

vi.mock('#routes/projects_.$id/chat-editor-viewer-registry.js', () => ({
  resolveViewer:
    () =>
    ({ filePath, content }: { filePath: string; content: string }) => (
      <div data-testid='viewer'>
        <div data-testid='viewer-path'>{filePath}</div>
        <div data-testid='viewer-content'>{content}</div>
      </div>
    ),
}));

vi.mock('#components/files/file-selector.js', () => ({
  FileSelector: () => <div data-testid='file-selector' />,
}));

const { FileEditor } = await import('#routes/projects_.$id/chat-editor-dockview.js');

const mockPanelApi = {
  updateParameters: vi.fn(),
  setTitle: vi.fn(),
} as unknown as IDockviewPanelProps['api'];

describe('FileEditor routing (R8 regression coverage)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render the loader when outcome is loading', () => {
    mockUseFileContent.mockReturnValue({ kind: 'loading' });

    const { container } = render(<FileEditor filePath='mystery.dat' panelApi={mockPanelApi} />);

    expect(container.querySelector('[data-slot="loader"], svg')).toBeTruthy();
  });

  it('should render the binary warning when outcome is binary, regardless of filename', () => {
    mockUseFileContent.mockReturnValue({
      kind: 'binary',
      size: 5 * 1024 * 1024,
      head: new Uint8Array([0x00, 0x01, 0x02]),
    });

    render(<FileEditor filePath='mystery.dat' panelApi={mockPanelApi} />);

    expect(screen.getByText(/binary or uses an unsupported text encoding/i)).toBeInTheDocument();
  });

  it('should re-resolve with forceText and large sizeLimit when Open Anyway is clicked on a binary file', async () => {
    const user = userEvent.setup();
    mockUseFileContent.mockReturnValue({
      kind: 'binary',
      size: 5 * 1024 * 1024,
      head: new Uint8Array([0x00, 0x01, 0x02]),
    });

    render(<FileEditor filePath='mystery.dat' panelApi={mockPanelApi} />);

    await user.click(screen.getByRole('button', { name: /open anyway/i }));

    expect(mockResolve).toHaveBeenCalledWith('mystery.dat', {
      forceText: true,
      sizeLimit: Number.MAX_SAFE_INTEGER,
    });
  });

  it('should render the too-large warning with size and limit when outcome is too-large', () => {
    mockUseFileContent.mockReturnValue({
      kind: 'too-large',
      size: 5 * 1024 * 1024,
      limit: 2 * 1024 * 1024,
    });

    render(<FileEditor filePath='mystery.dat' panelApi={mockPanelApi} />);

    expect(screen.getByText(/5\.0 MB/)).toBeInTheDocument();
    expect(screen.getByText(/2\.0 MB/)).toBeInTheDocument();
  });

  it('should re-resolve with large sizeLimit when Open Anyway is clicked on a too-large file', async () => {
    const user = userEvent.setup();
    mockUseFileContent.mockReturnValue({
      kind: 'too-large',
      size: 5 * 1024 * 1024,
      limit: 2 * 1024 * 1024,
    });

    render(<FileEditor filePath='mystery.dat' panelApi={mockPanelApi} />);

    await user.click(screen.getByRole('button', { name: /open anyway/i }));

    expect(mockResolve).toHaveBeenCalledWith('mystery.dat', {
      sizeLimit: Number.MAX_SAFE_INTEGER,
    });
  });

  it('should render the error placeholder with the cause when outcome is error', () => {
    mockUseFileContent.mockReturnValue({ kind: 'error', cause: new Error('disk on fire') });

    render(<FileEditor filePath='mystery.dat' panelApi={mockPanelApi} />);

    expect(screen.getByText(/failed to load file/i)).toBeInTheDocument();
    expect(screen.getByText(/disk on fire/)).toBeInTheDocument();
  });

  it('should render the file-not-found placeholder with the file selector when outcome is orphaned', () => {
    mockUseFileContent.mockReturnValue({ kind: 'orphaned' });

    render(<FileEditor filePath='mystery.dat' panelApi={mockPanelApi} />);

    expect(screen.getByText(/file not found/i)).toBeInTheDocument();
    expect(screen.getByTestId('file-selector')).toBeInTheDocument();
  });

  it('should render the resolved viewer with decoded text content when outcome is text', () => {
    const content = new TextEncoder().encode('hello world');
    mockUseFileContent.mockReturnValue({ kind: 'text', content });

    render(<FileEditor filePath='main.ts' panelApi={mockPanelApi} />);

    expect(screen.getByTestId('viewer')).toBeInTheDocument();
    expect(screen.getByTestId('viewer-content').textContent).toBe('hello world');
    expect(screen.getByTestId('viewer-path').textContent).toBe('main.ts');
  });

  describe('content-driven routing for neutral filenames', () => {
    it('should route a neutral-named file with NUL byte to the binary warning', () => {
      const head = new Uint8Array(512);
      head[0] = 0x00;
      mockUseFileContent.mockReturnValue({ kind: 'binary', size: 5 * 1024 * 1024, head });

      render(<FileEditor filePath='mystery.dat' panelApi={mockPanelApi} />);

      expect(screen.getByText(/binary or uses an unsupported text encoding/i)).toBeInTheDocument();
    });

    it('should route a neutral-named ASCII file over the open limit to the too-large warning', () => {
      mockUseFileContent.mockReturnValue({
        kind: 'too-large',
        size: 5 * 1024 * 1024,
        limit: 2 * 1024 * 1024,
      });

      render(<FileEditor filePath='mystery.dat' panelApi={mockPanelApi} />);

      expect(screen.getByText(/exceeds the .* editor limit/)).toBeInTheDocument();
    });

    it('should route small text content to the viewer regardless of filename', () => {
      mockUseFileContent.mockReturnValue({
        kind: 'text',
        content: new TextEncoder().encode('plain text'),
      });

      render(<FileEditor filePath='mystery.dat' panelApi={mockPanelApi} />);

      expect(screen.getByTestId('viewer')).toBeInTheDocument();
      expect(screen.getByTestId('viewer-content').textContent).toBe('plain text');
    });
  });
});
