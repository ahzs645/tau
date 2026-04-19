import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockContentService = {
  peek: vi.fn<(path: string) => Uint8Array<ArrayBuffer> | undefined>(),
  resolve: vi.fn<(path: string) => Promise<Uint8Array<ArrayBuffer>>>(),
  subscribe: vi.fn<(path: string | undefined, callback: () => void) => () => void>(),
  isOrphaned: vi.fn<(path: string) => boolean>(),
  onDidChangeOrphaned: vi.fn<(handler: (event: { path: string; orphaned: boolean }) => void) => () => void>(),
};

vi.mock('#hooks/use-file-manager.js', () => ({
  useFileManager: () => ({ contentService: mockContentService }),
}));

const { useFileContent } = await import('#hooks/use-file-content.js');

describe('useFileContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContentService.peek.mockReturnValue(undefined);
    mockContentService.resolve.mockResolvedValue(new Uint8Array([1, 2, 3]));
    mockContentService.subscribe.mockImplementation((_path, _callback) => () => {
      /* No-op unsubscribe */
    });
    mockContentService.isOrphaned.mockReturnValue(false);
    mockContentService.onDidChangeOrphaned.mockImplementation((_handler) => () => {
      /* No-op unsubscribe */
    });
  });

  it('should return content from contentService.peek()', () => {
    const data = new Uint8Array([10, 20, 30]);
    mockContentService.peek.mockReturnValue(data);

    const { result } = renderHook(() => useFileContent('main.ts'));

    expect(result.current.content).toEqual(data);
  });

  it('should trigger resolve on cache miss', () => {
    mockContentService.peek.mockReturnValue(undefined);

    renderHook(() => useFileContent('main.ts'));

    expect(mockContentService.resolve).toHaveBeenCalledWith('main.ts');
  });

  it('should return isOrphaned=true when contentService reports orphaned', () => {
    mockContentService.isOrphaned.mockReturnValue(true);

    const { result } = renderHook(() => useFileContent('missing.ts'));

    expect(result.current.isOrphaned).toBe(true);
  });

  it('should return isOrphaned=false when file resolves successfully', () => {
    mockContentService.peek.mockReturnValue(new Uint8Array([1]));
    mockContentService.isOrphaned.mockReturnValue(false);

    const { result } = renderHook(() => useFileContent('main.ts'));

    expect(result.current.isOrphaned).toBe(false);
  });
});
