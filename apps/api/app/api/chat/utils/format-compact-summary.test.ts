import { describe, it, expect } from 'vitest';
import { formatCompactSummary, parseCompactSummary } from '#api/chat/utils/format-compact-summary.js';

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

// =============================================================================
// parseCompactSummary — per docs/research/system-prompt-audit.md R21
// =============================================================================
//
// The compaction prompt asks Morph for a 9-section summary (Primary Request,
// Key Technical Concepts, Files and Code Sections, Errors and Fixes, Problem
// Solving, All User Messages, Pending Tasks, Current Work, Optional Next Step).
// `parseCompactSummary` is the structural validator — when any of those sections
// is absent, the compaction service must throw so the middleware falls back to
// the truncate-tool-args tier instead of shipping a malformed summary.

const wellFormedSummary = `1. Primary Request and Intent: Build a parametric cube.
2. Key Technical Concepts: OpenSCAD primitives, parameter file overrides.
3. Files and Code Sections: main.scad — declares the top-level cube.
4. Errors and Fixes: Initial run failed because of a missing module; fixed by importing lib/units.scad.
5. Problem Solving: Iterated on dimensions until tests passed.
6. All User Messages: "make a 100mm cube"
7. Pending Tasks: None.
8. Current Work: Cube built and verified.
9. Optional Next Step: Surface dimensions in the parameter UI.`;

describe('parseCompactSummary', () => {
  it('returns ok:true when all 9 numbered sections are present', () => {
    const result = parseCompactSummary(wellFormedSummary);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sections).toHaveLength(9);
    }
  });

  it('returns ok:false and lists missing sections when any are absent', () => {
    const missingSeven = wellFormedSummary
      .split('\n')
      .filter((line) => !line.startsWith('7. '))
      .join('\n');

    const result = parseCompactSummary(missingSeven);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingSections).toContain('Pending Tasks');
    }
  });

  it('returns ok:false when the section is renamed (heading mismatch)', () => {
    const renamed = wellFormedSummary.replace('1. Primary Request and Intent', '1. Main Goal');

    const result = parseCompactSummary(renamed);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingSections).toContain('Primary Request and Intent');
    }
  });

  it('returns ok:false for empty / whitespace input', () => {
    expect(parseCompactSummary('').ok).toBe(false);
    expect(parseCompactSummary('   \n\n  ').ok).toBe(false);
  });

  it('returns ok:false and lists every missing section when many are absent', () => {
    const onlyFirstThree = `1. Primary Request and Intent: x
2. Key Technical Concepts: y
3. Files and Code Sections: z`;

    const result = parseCompactSummary(onlyFirstThree);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingSections).toEqual([
        'Errors and Fixes',
        'Problem Solving',
        'All User Messages',
        'Pending Tasks',
        'Current Work',
        'Optional Next Step',
      ]);
    }
  });
});
