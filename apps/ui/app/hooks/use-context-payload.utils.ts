import type { SkillMetadata } from '@taucad/chat';

/**
 * Parse YAML frontmatter from a SKILL.md file to extract skill metadata.
 * Uses regex instead of a full YAML parser since only `name` and `description`
 * flat string fields are needed.
 *
 * @param content - Raw file content of the SKILL.md
 * @param filePath - Path to the SKILL.md file (e.g. `.tau/skills/my-skill/SKILL.md`)
 * @returns Parsed skill metadata, or undefined if frontmatter is missing or incomplete
 */
export function parseSkillFrontmatter(content: string, filePath: string): SkillMetadata | undefined {
  const match = /^---\n([\S\s]*?)\n---/.exec(content);
  if (!match?.[1]) {
    return undefined;
  }

  const frontmatter = match[1];
  const name = /^name:\s*["']?(.+?)["']?\s*$/m.exec(frontmatter)?.[1];
  const description = /^description:\s*["']?(.+?)["']?\s*$/m.exec(frontmatter)?.[1];

  if (!name || !description) {
    return undefined;
  }

  return {
    name,
    description,
    path: filePath.replace(/\/SKILL\.md$/, ''),
  };
}
