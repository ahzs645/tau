import { describe, it, expect } from 'vitest';
import { parseSkillFrontmatter } from '#hooks/use-context-payload.utils.js';

describe('parseSkillFrontmatter', () => {
  it('should parse valid YAML frontmatter with name and description', () => {
    const content = `---
name: my-skill
description: A useful skill for testing
---

# My Skill

Some content here.
`;
    const result = parseSkillFrontmatter(content, '.tau/skills/my-skill/SKILL.md');

    expect(result).toEqual({
      name: 'my-skill',
      description: 'A useful skill for testing',
      path: '.tau/skills/my-skill',
    });
  });

  it('should return undefined for content without frontmatter', () => {
    const content = '# Just a heading\n\nNo frontmatter here.';

    expect(parseSkillFrontmatter(content, '.tau/skills/x/SKILL.md')).toBeUndefined();
  });

  it('should return undefined when name is missing', () => {
    const content = `---
description: Missing name field
---
`;
    expect(parseSkillFrontmatter(content, '.tau/skills/x/SKILL.md')).toBeUndefined();
  });

  it('should return undefined when description is missing', () => {
    const content = `---
name: incomplete-skill
---
`;
    expect(parseSkillFrontmatter(content, '.tau/skills/x/SKILL.md')).toBeUndefined();
  });

  it('should handle single-quoted values in frontmatter', () => {
    const content = `---
name: 'quoted-skill'
description: 'A skill with quoted values'
---
`;
    const result = parseSkillFrontmatter(content, '.tau/skills/quoted-skill/SKILL.md');

    expect(result).toEqual({
      name: 'quoted-skill',
      description: 'A skill with quoted values',
      path: '.tau/skills/quoted-skill',
    });
  });

  it('should handle double-quoted values in frontmatter', () => {
    const content = `---
name: "double-quoted"
description: "Uses double quotes"
---
`;
    const result = parseSkillFrontmatter(content, '.tau/skills/double-quoted/SKILL.md');

    expect(result).toEqual({
      name: 'double-quoted',
      description: 'Uses double quotes',
      path: '.tau/skills/double-quoted',
    });
  });

  it('should strip SKILL.md from path to produce skill directory path', () => {
    const content = `---
name: nested
description: Nested skill
---
`;
    const result = parseSkillFrontmatter(content, '.tau/skills/deeply/nested/SKILL.md');

    expect(result?.path).toBe('.tau/skills/deeply/nested');
  });

  it('should return undefined for empty frontmatter block', () => {
    const content = `---
---
`;
    expect(parseSkillFrontmatter(content, '.tau/skills/x/SKILL.md')).toBeUndefined();
  });

  it('should handle frontmatter with extra fields gracefully', () => {
    const content = `---
name: extra-fields
description: Has extra fields
status: active
category: testing
---
`;
    const result = parseSkillFrontmatter(content, '.tau/skills/extra-fields/SKILL.md');

    expect(result).toEqual({
      name: 'extra-fields',
      description: 'Has extra fields',
      path: '.tau/skills/extra-fields',
    });
  });
});
