import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileSelector, createStaticDataSource } from '#components/files/file-selector.js';
import type { FileSelectorDataSource, FileSelectorEntry } from '#components/files/file-selector.js';

vi.mock('#hooks/use-mobile.js', () => ({
  useIsMobile: () => false,
}));

vi.mock('#hooks/use-file-manager.js', () => ({
  useOptionalFileManager: vi.fn(() => undefined),
}));

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const rootEntries: FileSelectorEntry[] = [
  { name: 'src', path: 'src', isFolder: true },
  { name: 'README.md', path: 'README.md', isFolder: false, size: 200 },
];

const sourceEntries: FileSelectorEntry[] = [
  { name: 'main.ts', path: 'src/main.ts', isFolder: false, size: 100 },
  { name: 'utils', path: 'src/utils', isFolder: true },
];

const searchResults: FileSelectorEntry[] = [{ name: 'main.ts', path: 'src/main.ts', isFolder: false, size: 100 }];

function createMockDataSource(): {
  dataSource: FileSelectorDataSource;
  loadDirectory: ReturnType<typeof vi.fn>;
  searchFiles: ReturnType<typeof vi.fn>;
} {
  const loadDirectory = vi.fn().mockImplementation(async (path: string) => {
    if (path === '' || path === '/') {
      return rootEntries;
    }
    if (path === 'src') {
      return sourceEntries;
    }
    return [];
  });
  const searchFiles = vi.fn().mockResolvedValue(searchResults);

  return { dataSource: { loadDirectory, searchFiles }, loadDirectory, searchFiles };
}

describe('FileSelector (explicit dataSource)', () => {
  it('should call loadDirectory on open to show root items', async () => {
    const { dataSource, loadDirectory } = createMockDataSource();

    render(<FileSelector dataSource={dataSource} selectedFile={undefined} onSelect={vi.fn()} />);

    await userEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(loadDirectory).toHaveBeenCalledWith('');
    });

    await waitFor(() => {
      expect(screen.getByText('src')).toBeInTheDocument();
      expect(screen.getByText('README.md')).toBeInTheDocument();
    });
  });

  it('should call loadDirectory when user clicks a directory', async () => {
    const { dataSource, loadDirectory } = createMockDataSource();

    render(<FileSelector dataSource={dataSource} selectedFile={undefined} onSelect={vi.fn()} />);

    await userEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(screen.getByText('src')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText('src'));

    await waitFor(() => {
      expect(loadDirectory).toHaveBeenCalledWith('src');
    });

    await waitFor(() => {
      expect(screen.getByText('main.ts')).toBeInTheDocument();
    });
  });

  it('should show loading indicator while loadDirectory resolves', async () => {
    let resolveLoad: (value: FileSelectorEntry[]) => void;
    const slowLoad = vi.fn().mockImplementation(
      async () =>
        new Promise<FileSelectorEntry[]>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const dataSource: FileSelectorDataSource = {
      loadDirectory: slowLoad,
      searchFiles: vi.fn().mockResolvedValue([]),
    };

    render(<FileSelector dataSource={dataSource} selectedFile={undefined} onSelect={vi.fn()} />);

    await userEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(slowLoad).toHaveBeenCalled();
    });

    resolveLoad!(rootEntries);

    await waitFor(() => {
      expect(screen.getByText('README.md')).toBeInTheDocument();
    });
  });

  it('should call searchFiles when user types in search box', async () => {
    const { dataSource, searchFiles } = createMockDataSource();

    render(<FileSelector dataSource={dataSource} selectedFile={undefined} onSelect={vi.fn()} />);

    await userEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(screen.getByText('README.md')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search files...');
    await userEvent.type(searchInput, 'main');

    await waitFor(() => {
      expect(searchFiles).toHaveBeenCalledWith('main');
    });
  });

  it('should display search results from searchFiles', async () => {
    const { dataSource } = createMockDataSource();

    render(<FileSelector dataSource={dataSource} selectedFile={undefined} onSelect={vi.fn()} />);

    await userEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(screen.getByText('README.md')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search files...');
    await userEvent.type(searchInput, 'main');

    await waitFor(() => {
      expect(screen.getByText('main.ts')).toBeInTheDocument();
    });
  });

  it('should clear search and return to directory view when search is cleared', async () => {
    const { dataSource, searchFiles } = createMockDataSource();

    render(<FileSelector dataSource={dataSource} selectedFile={undefined} onSelect={vi.fn()} />);

    await userEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(screen.getByText('README.md')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search files...');
    await userEvent.type(searchInput, 'main');

    await waitFor(() => {
      expect(searchFiles).toHaveBeenCalled();
    });

    await userEvent.clear(searchInput);

    await waitFor(() => {
      expect(screen.getByText('README.md')).toBeInTheDocument();
    });
  });

  it('should call onSelect with the correct path', async () => {
    const { dataSource } = createMockDataSource();
    const onSelect = vi.fn();

    render(<FileSelector dataSource={dataSource} selectedFile={undefined} onSelect={onSelect} />);

    await userEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(screen.getByText('README.md')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText('README.md'));

    expect(onSelect).toHaveBeenCalledWith('README.md');
  });
});

describe('createStaticDataSource', () => {
  it('should return root-level items for loadDirectory("")', async () => {
    const ds = createStaticDataSource([
      { path: 'src/main.ts', size: 100 },
      { path: 'README.md', size: 200 },
    ]);

    const items = await ds.loadDirectory('');
    expect(items).toEqual([
      { name: 'src', path: 'src', isFolder: true, size: undefined },
      { name: 'README.md', path: 'README.md', isFolder: false, size: 200 },
    ]);
  });

  it('should return nested items for loadDirectory("src")', async () => {
    const ds = createStaticDataSource([
      { path: 'src/main.ts', size: 100 },
      { path: 'src/utils/helpers.ts', size: 50 },
    ]);

    const items = await ds.loadDirectory('src');
    expect(items).toEqual([
      { name: 'utils', path: 'src/utils', isFolder: true, size: undefined },
      { name: 'main.ts', path: 'src/main.ts', isFolder: false, size: 100 },
    ]);
  });

  it('should filter files via searchFiles', async () => {
    const ds = createStaticDataSource([
      { path: 'src/main.ts', size: 100 },
      { path: 'src/utils/helpers.ts', size: 50 },
      { path: 'README.md', size: 200 },
    ]);

    const results = await ds.searchFiles('main');
    expect(results).toEqual([{ name: 'main.ts', path: 'src/main.ts', isFolder: false, size: 100 }]);
  });

  it('should render correctly via FileSelector with createStaticDataSource', async () => {
    const ds = createStaticDataSource([
      { path: 'hello.ts', size: 42 },
      { path: 'world.ts', size: 99 },
    ]);

    render(<FileSelector dataSource={ds} selectedFile={undefined} onSelect={vi.fn()} />);

    await userEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(screen.getByText('hello.ts')).toBeInTheDocument();
      expect(screen.getByText('world.ts')).toBeInTheDocument();
    });
  });
});

describe('FileSelector (context auto-wiring)', () => {
  it('should render without errors when no dataSource and no FileManagerProvider', async () => {
    render(<FileSelector selectedFile={undefined} onSelect={vi.fn()} />);

    await userEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(screen.getByText('No files found.')).toBeInTheDocument();
    });
  });
});
