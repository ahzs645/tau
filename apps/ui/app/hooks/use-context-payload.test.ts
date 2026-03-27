import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FileTreeEntry } from '@taucad/types';

const mockReadFile = vi.fn<(path: string) => Promise<Uint8Array<ArrayBuffer>>>();
const mockFileTree = vi.fn<() => FileTreeEntry[] | undefined>();

vi.mock('#hooks/use-file-manager.js', () => ({
  useFileTree: () => mockFileTree(),
  useFileManager: () => ({ readFile: mockReadFile }),
}));

// Import after mocks are set up
const { useContextPayload } = await import('#hooks/use-context-payload.js');

const encoder = new TextEncoder();

function makeSkillMd(name: string, description: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`---\nname: ${name}\ndescription: '${description}'\n---\n\n# ${name}\n\nSkill content.`);
}

function makeFileEntry(path: string, type: 'file' | 'dir' = 'file', size = 100): FileTreeEntry {
  return { path, name: path.split('/').pop()!, type, size };
}

describe('useContextPayload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFileTree.mockReturnValue(undefined);
    mockReadFile.mockRejectedValue(new Error('not found'));
  });

  it('should return undefined when file tree is undefined', () => {
    mockFileTree.mockReturnValue(undefined);

    const { result } = renderHook(() => useContextPayload());

    expect(result.current).toBeUndefined();
  });

  it('should return undefined when file tree has no .tau directory', () => {
    mockFileTree.mockReturnValue([makeFileEntry('main.scad'), makeFileEntry('lib/utils.scad')]);

    const { result } = renderHook(() => useContextPayload());

    expect(result.current).toBeUndefined();
  });

  it('should discover skills from .tau/skills/ subdirectories', async () => {
    mockFileTree.mockReturnValue([
      makeFileEntry('main.scad'),
      makeFileEntry('.tau/skills/cad-expert/SKILL.md'),
      makeFileEntry('.tau/skills/testing/SKILL.md'),
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
    mockFileTree.mockReturnValue([makeFileEntry('main.scad'), makeFileEntry('.tau/AGENTS.md')]);
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

    const agentsKey = '.tau/AGENTS.md';
    expect(result.current!.memory).toEqual({
      [agentsKey]: agentsContent,
    });
  });

  it('should handle empty .tau/skills/ directory', () => {
    mockFileTree.mockReturnValue([makeFileEntry('.tau/skills', 'dir')]);

    const { result } = renderHook(() => useContextPayload());

    expect(result.current).toBeUndefined();
  });

  it('should skip SKILL.md files with malformed frontmatter', async () => {
    mockFileTree.mockReturnValue([
      makeFileEntry('.tau/skills/good/SKILL.md'),
      makeFileEntry('.tau/skills/bad/SKILL.md'),
    ]);
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

  it('should update payload when file tree changes', async () => {
    mockFileTree.mockReturnValue([]);

    const { result, rerender } = renderHook(() => useContextPayload());

    expect(result.current).toBeUndefined();

    mockFileTree.mockReturnValue([makeFileEntry('.tau/skills/new-skill/SKILL.md')]);
    mockReadFile.mockImplementation(async () => makeSkillMd('new-skill', 'Just appeared'));

    await act(async () => {
      rerender();
    });

    await waitFor(() => {
      expect(result.current?.skills).toHaveLength(1);
    });

    expect(result.current!.skills![0]!.name).toBe('new-skill');
  });

  it('should return both skills and memory when both present', async () => {
    mockFileTree.mockReturnValue([makeFileEntry('.tau/skills/my-skill/SKILL.md'), makeFileEntry('.tau/AGENTS.md')]);
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
    mockFileTree.mockReturnValue([
      makeFileEntry('.tau/skills/good/SKILL.md'),
      makeFileEntry('.tau/skills/broken/SKILL.md'),
    ]);
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
