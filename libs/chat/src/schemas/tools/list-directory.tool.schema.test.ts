import { describe, it, expect } from 'vitest';
import { listDirectoryInputSchema } from '#schemas/tools/list-directory.tool.schema.js';

describe('listDirectoryInputSchema', () => {
  it('should document path as workspace-relative root aliases with no project-id prefix', () => {
    const description = listDirectoryInputSchema.shape.path.description ?? '';
    expect(description).toContain("''");
    expect(description).toContain("'.'");
    expect(description).toContain("'./'");
    expect(description).toContain("'/'");
    expect(description.toLowerCase()).toMatch(/workspace[ -]relative|relative to the workspace/);
    expect(description.toLowerCase()).toMatch(/do not embed|do not.*prefix|never prefix|must not/);
    expect(description.toLowerCase()).toMatch(/project(\s+|-)?id|project identifiers/);
  });
});
