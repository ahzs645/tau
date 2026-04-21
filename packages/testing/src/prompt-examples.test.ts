import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_CHECKS_COPY,
  CANONICAL_TEST_REQUIREMENTS_EXAMPLE,
  renderCanonicalExample,
} from '#prompt-examples.js';

describe('CANONICAL_TEST_REQUIREMENTS_EXAMPLE', () => {
  it('should expose a per-file map keyed by the <file> placeholder', () => {
    expect(Object.keys(CANONICAL_TEST_REQUIREMENTS_EXAMPLE)).toEqual(['<file>']);
    const entry = CANONICAL_TEST_REQUIREMENTS_EXAMPLE['<file>'];
    expect(Array.isArray(entry.requirements)).toBe(true);
    expect(entry.requirements.length).toBeGreaterThan(0);
  });

  it('should include exactly one example per agent-facing check (boundingBox, connectedComponents, watertight)', () => {
    const checks = CANONICAL_TEST_REQUIREMENTS_EXAMPLE['<file>'].requirements.map((r) => r.check);
    expect(checks).toContain('boundingBox');
    expect(checks).toContain('connectedComponents');
    expect(checks).toContain('watertight');
  });

  it('should never reference the deprecated meshCount or vertexCount checks', () => {
    const json = JSON.stringify(CANONICAL_TEST_REQUIREMENTS_EXAMPLE);
    expect(json).not.toContain('meshCount');
    expect(json).not.toContain('vertexCount');
  });
});

describe('renderCanonicalExample', () => {
  it('should substitute the supplied file extension into the example key', () => {
    const rendered = renderCanonicalExample('ts');
    expect(rendered).toContain('"main.ts"');
    expect(rendered).not.toContain('<file>');
  });

  it('should produce a fenced JSON code block that round-trips through JSON.parse', () => {
    const rendered = renderCanonicalExample('scad');
    expect(rendered).toMatch(/^```json/);
    expect(rendered).toMatch(/```$/);
    const body = rendered.replace(/^```json\n/, '').replace(/\n```$/, '');
    expect(() => {
      JSON.parse(body);
    }).not.toThrow();
  });

  it('should accept a leading dot on the extension (defensive normalisation)', () => {
    expect(renderCanonicalExample('.ts')).toContain('"main.ts"');
  });
});

describe('AVAILABLE_CHECKS_COPY', () => {
  it('should mention all 3 surviving checks with their unique-question framing', () => {
    expect(AVAILABLE_CHECKS_COPY).toContain('boundingBox');
    expect(AVAILABLE_CHECKS_COPY).toContain('connectedComponents');
    expect(AVAILABLE_CHECKS_COPY).toContain('watertight');
    expect(AVAILABLE_CHECKS_COPY).toContain('SIZE / POSITION');
    expect(AVAILABLE_CHECKS_COPY).toContain('SPATIALLY-DISJOINT CHUNKS');
    expect(AVAILABLE_CHECKS_COPY).toContain('CLOSED (manifold / 3D-printable)');
  });

  it('should explicitly mention the connectedComponents tolerance knob (mm) and its default', () => {
    expect(AVAILABLE_CHECKS_COPY).toContain('tolerance');
    expect(AVAILABLE_CHECKS_COPY).toContain('mm');
    expect(AVAILABLE_CHECKS_COPY).toContain('default 0.1');
  });

  it('should never reference the deprecated meshCount or vertexCount checks', () => {
    expect(AVAILABLE_CHECKS_COPY).not.toContain('meshCount');
    expect(AVAILABLE_CHECKS_COPY).not.toContain('vertexCount');
  });

  it('should clarify that "is this one fused solid?" maps to watertight (not connectedComponents:1)', () => {
    expect(AVAILABLE_CHECKS_COPY).toContain('one fused solid');
    expect(AVAILABLE_CHECKS_COPY).toContain('watertight');
  });
});
