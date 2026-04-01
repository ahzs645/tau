import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FileEntry } from '@taucad/types';
import type { FileTreeNode } from '@taucad/filesystem';

const mockReadFile = vi.fn<(path: string) => Promise<Uint8Array<ArrayBuffer>>>();
const mockReadDirectoryEntries = vi.fn<(path: string) => Promise<FileTreeNode[]>>();
const mockGetEntry = vi.fn<(path: string) => Promise<FileEntry | undefined>>();

vi.mock('#hooks/use-file-manager.js', () => ({
  useFileManager: () => ({
    readFile: mockReadFile,
    treeService: {
      readDirectoryEntries: mockReadDirectoryEntries,
      getEntry: mockGetEntry,
    },
  }),
}));

const { useContextPayload } = await import('#hooks/use-context-payload.js');

const encoder = new TextEncoder();

function makeSkillMd(name: string, description: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`---\nname: ${name}\ndescription: '${description}'\n---\n\n# ${name}\n\nSkill content.`);
}

function makeSkillDirectoryNode(name: string): FileTreeNode {
  return { id: `.tau/skills/${name}`, name, children: [] };
}

function makeFileEntry(path: string, type: 'file' | 'dir' = 'file'): FileEntry {
  return { path, name: path.split('/').pop()!, type, size: 100, isLoaded: true, mtimeMs: 0 };
}

describe('useContextPayload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadDirectoryEntries.mockResolvedValue([]);
    mockGetEntry.mockResolvedValue(undefined);
    mockReadFile.mockRejectedValue(new Error('not found'));
  });

  it('should return undefined when .tau/skills is empty and no AGENTS.md', async () => {
    const { result } = renderHook(() => useContextPayload());

    await waitFor(() => {
      expect(mockReadDirectoryEntries).toHaveBeenCalledWith('.tau/skills');
    });

    expect(result.current).toBeUndefined();
  });

  it('should return undefined when no skill directories exist', async () => {
    mockReadDirectoryEntries.mockResolvedValue([{ id: '.tau/skills/readme.md', name: 'readme.md' }]);

    const { result } = renderHook(() => useContextPayload());

    await waitFor(() => {
      expect(mockReadDirectoryEntries).toHaveBeenCalled();
    });

    expect(result.current).toBeUndefined();
  });

  it('should discover skills from .tau/skills/ subdirectories', async () => {
    mockReadDirectoryEntries.mockResolvedValue([
      makeSkillDirectoryNode('cad-expert'),
      makeSkillDirectoryNode('testing'),
    ]);
    mockReadFile.mockImplementation(async (path: string) => {
      if (path.includes('cad-expert')) {
        return makeSkillMd('cad-expert', 'CAD modeling expertise');
      }
      if (path.includes('testing')) {
        return makeSkillMd('testing', 'Test writing support');
      }
      throw new Error('not found');
    });

    const { result } = renderHook(() => useContextPayload());

    await waitFor(() => {
      expect(result.current?.skills).toHaveLength(2);
    });

    expect(result.current!.skills).toEqual(
      expect.arrayContaining([
        { name: 'cad-expert', description: 'CAD modeling expertise', path: '.tau/skills/cad-expert' },
        { name: 'testing', description: 'Test writing support', path: '.tau/skills/testing' },
      ]),
    );
  });

  it('should read AGENTS.md content into memory payload', async () => {
    const agentsContent = '# AGENTS\n\nPrefer early returns.';
    mockGetEntry.mockResolvedValue(makeFileEntry('.tau/AGENTS.md'));
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === '.tau/AGENTS.md') {
        return encoder.encode(agentsContent);
      }
      throw new Error('not found');
    });

    const { result } = renderHook(() => useContextPayload());

    await waitFor(() => {
      expect(result.current?.memory).toBeDefined();
    });

    // eslint-disable-next-line @typescript-eslint/naming-convention -- fixture path key
    expect(result.current!.memory).toEqual({ '.tau/AGENTS.md': agentsContent });
  });

  it('should handle empty .tau/skills/ directory', async () => {
    mockReadDirectoryEntries.mockResolvedValue([]);

    const { result } = renderHook(() => useContextPayload());

    await waitFor(() => {
      expect(mockReadDirectoryEntries).toHaveBeenCalled();
    });

    expect(result.current).toBeUndefined();
  });

  it('should skip SKILL.md files with malformed frontmatter', async () => {
    mockReadDirectoryEntries.mockResolvedValue([makeSkillDirectoryNode('good'), makeSkillDirectoryNode('bad')]);
    mockReadFile.mockImplementation(async (path: string) => {
      if (path.includes('good')) {
        return makeSkillMd('good-skill', 'Works correctly');
      }
      if (path.includes('bad')) {
        return encoder.encode('# No frontmatter here');
      }
      throw new Error('not found');
    });

    const { result } = renderHook(() => useContextPayload());

    await waitFor(() => {
      expect(result.current?.skills).toHaveLength(1);
    });

    expect(result.current!.skills![0]).toEqual({
      name: 'good-skill',
      description: 'Works correctly',
      path: '.tau/skills/good',
    });
  });

  it('should return both skills and memory when both present', async () => {
    mockReadDirectoryEntries.mockResolvedValue([makeSkillDirectoryNode('my-skill')]);
    mockGetEntry.mockResolvedValue(makeFileEntry('.tau/AGENTS.md'));
    mockReadFile.mockImplementation(async (path: string) => {
      if (path.includes('SKILL.md')) {
        return makeSkillMd('my-skill', 'A skill');
      }
      if (path === '.tau/AGENTS.md') {
        return encoder.encode('Memory content');
      }
      throw new Error('not found');
    });

    const { result } = renderHook(() => useContextPayload());

    await waitFor(() => {
      expect(result.current?.skills).toHaveLength(1);
      expect(result.current?.memory).toBeDefined();
    });

    expect(result.current!.skills![0]!.name).toBe('my-skill');
    expect(result.current!.memory!['.tau/AGENTS.md']).toBe('Memory content');
  });

  it('should handle readFile errors gracefully for individual skills', async () => {
    mockReadDirectoryEntries.mockResolvedValue([makeSkillDirectoryNode('good'), makeSkillDirectoryNode('broken')]);
    mockReadFile.mockImplementation(async (path: string) => {
      if (path.includes('good')) {
        return makeSkillMd('good-skill', 'Works');
      }
      throw new Error('disk error');
    });

    const { result } = renderHook(() => useContextPayload());

    await waitFor(() => {
      expect(result.current?.skills).toHaveLength(1);
    });

    expect(result.current!.skills![0]!.name).toBe('good-skill');
  });
});
