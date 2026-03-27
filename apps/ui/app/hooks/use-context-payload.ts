import { useState, useEffect, useMemo, useRef } from 'react';
import type { ContextPayload, SkillMetadata } from '@taucad/chat';
import { useFileTree, useFileManager } from '#hooks/use-file-manager.js';
import { parseSkillFrontmatter } from '#hooks/use-context-payload.utils.js';

const skillPathPattern = /^\.tau\/skills\/[^/]+\/SKILL\.md$/;
const agentsMdPath = '.tau/AGENTS.md';
const decoder = new TextDecoder();

/**
 * Hook that assembles a context payload from the project's `.tau/` directory.
 * Reads `.tau/skills/` SKILL.md frontmatter and `.tau/AGENTS.md` from ZenFS,
 * caching results and re-reading when the file tree changes.
 *
 * @returns ContextPayload to attach to message metadata, or undefined if nothing to send
 */
export function useContextPayload(): ContextPayload | undefined {
  const fileTree = useFileTree();
  const { readFile } = useFileManager();
  const [skills, setSkills] = useState<SkillMetadata[]>([]);
  const [memory, setMemory] = useState<Record<string, string> | undefined>();

  const skillPaths = useMemo(
    () =>
      fileTree
        ?.filter((entry) => entry.type === 'file' && skillPathPattern.test(entry.path))
        .map((entry) => entry.path) ?? [],
    [fileTree],
  );

  const hasAgentsMd = useMemo(
    () => fileTree?.some((entry) => entry.type === 'file' && entry.path === agentsMdPath) ?? false,
    [fileTree],
  );

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
