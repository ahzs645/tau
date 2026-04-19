import { describe, it, expect } from 'vitest';
import { formatCompactSummary } from '#api/chat/utils/format-compact-summary.js';

describe('formatCompactSummary', () => {
  it('should strip <analysis> block and preserve <summary> content', () => {
    const input = `<analysis>
Let me review the conversation chronologically...
The user asked for a cube, then changed to a sphere.
</analysis>
<summary>
1. Primary Request: Build a sphere
2. Key Technical Concepts: OpenSCAD primitives
</summary>`;

    const result = formatCompactSummary(input);

    expect(result).not.toContain('<analysis>');
    expect(result).not.toContain('</analysis>');
    expect(result).not.toContain('Let me review the conversation');
    expect(result).toContain('Primary Request: Build a sphere');
    expect(result).toContain('Key Technical Concepts: OpenSCAD primitives');
  });

  it('should handle response with only <summary> and no analysis', () => {
    const input = `<summary>
1. Primary Request: Build a cube
</summary>`;

    const result = formatCompactSummary(input);

    expect(result).toContain('Primary Request: Build a cube');
    expect(result).not.toContain('<summary>');
    expect(result).not.toContain('</summary>');
  });

  it('should handle response with neither tag as passthrough', () => {
    const input = 'Just a plain text summary without any XML tags.';

    const result = formatCompactSummary(input);

    expect(result).toBe(input);
  });

  it('should normalize multiple blank lines', () => {
    const input = `<summary>
Section 1



Section 2


Section 3
</summary>`;

    const result = formatCompactSummary(input);

    expect(result).not.toMatch(/\n{3,}/);
    expect(result).toContain('Section 1');
    expect(result).toContain('Section 2');
    expect(result).toContain('Section 3');
  });

  it('should handle multiline analysis content', () => {
    const input = `<analysis>
Line 1 of analysis
Line 2 of analysis
Line 3 with code: const x = 1;
More analysis with <tags> inside
</analysis>
<summary>
The actual summary content here.
</summary>`;

    const result = formatCompactSummary(input);

    expect(result).not.toContain('Line 1 of analysis');
    expect(result).not.toContain('<tags>');
    expect(result).toContain('The actual summary content here.');
  });
});
