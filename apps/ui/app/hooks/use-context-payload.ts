import { useState, useEffect, useMemo, useRef } from 'react';
import type { ContextPayload, SkillMetadata } from '@taucad/chat';
import { useFileManager } from '#hooks/use-file-manager.js';
import { parseSkillFrontmatter } from '#hooks/use-context-payload.utils.js';

const agentsMdPath = '.tau/AGENTS.md';
const decoder = new TextDecoder();

/**
 * Hook that assembles a context payload from the project's `.tau/` directory.
 * Uses targeted reads: `readDirectoryEntries('.tau/skills')` to discover skill
 * directories and `getEntry('.tau/AGENTS.md')` for memory — never scans the
 * full project tree.
 *
 * @returns ContextPayload to attach to message metadata, or undefined if nothing to send
 */
export function useContextPayload(): ContextPayload | undefined {
  const { readFile, treeService } = useFileManager();
  const [skillPaths, setSkillPaths] = useState<string[]>([]);
  const [hasAgentsMd, setHasAgentsMd] = useState(false);
  const [skills, setSkills] = useState<SkillMetadata[]>([]);
  const [memory, setMemory] = useState<Record<string, string> | undefined>();

  useEffect(() => {
    if (!treeService) {
      return;
    }
    let cancelled = false;

    async function discover(): Promise<void> {
      const [skillDirectories, agentsEntry] = await Promise.all([
        treeService!.readDirectoryEntries('.tau/skills').catch(() => []),
        treeService!.getEntry(agentsMdPath),
      ]);

      if (cancelled) {
        return;
      }

      const paths = skillDirectories
        .filter((node) => node.children !== undefined)
        .map((node) => `.tau/skills/${node.name}/SKILL.md`);

      setSkillPaths(paths);
      setHasAgentsMd(agentsEntry?.type === 'file');
    }

    void discover();
    return () => {
      cancelled = true;
    };
  }, [treeService]);

  const readFileRef = useRef(readFile);
  readFileRef.current = readFile;

  useEffect(() => {
    let cancelled = false;

    async function loadSkills(): Promise<void> {
      if (skillPaths.length === 0) {
        setSkills([]);
        return;
      }

      const results = await Promise.all(
        skillPaths.map(async (path) => {
          try {
            const bytes = await readFileRef.current(path);
            const text = decoder.decode(bytes);
            return parseSkillFrontmatter(text, path);
          } catch {
            return undefined;
          }
        }),
      );

      if (!cancelled) {
        setSkills(results.filter((s): s is SkillMetadata => s !== undefined));
      }
    }

    void loadSkills();
    return () => {
      cancelled = true;
    };
  }, [skillPaths]);

  useEffect(() => {
    let cancelled = false;

    async function loadMemory(): Promise<void> {
      if (!hasAgentsMd) {
        setMemory(undefined);
        return;
      }

      try {
        const bytes = await readFileRef.current(agentsMdPath);
        const text = decoder.decode(bytes);
        if (!cancelled) {
          setMemory({ [agentsMdPath]: text });
        }
      } catch {
        if (!cancelled) {
          setMemory(undefined);
        }
      }
    }

    void loadMemory();
    return () => {
      cancelled = true;
    };
  }, [hasAgentsMd]);

  return useMemo((): ContextPayload | undefined => {
    if (skills.length === 0 && !memory) {
      return undefined;
    }

    return {
      skills: skills.length > 0 ? skills : undefined,
      memory,
    };
  }, [skills, memory]);
}
