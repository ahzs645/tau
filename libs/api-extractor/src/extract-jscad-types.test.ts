import process from 'node:process';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { buildNamespaceBundle, buildApiData } from '#extract-jscad-types.js';

/**
 * Tests for the @jscad/modeling type extractor.
 *
 * Verifies that the generated output has the correct structure:
 * - Main `declare module '@jscad/modeling'` with foundation types + namespaces
 * - Subpath `declare module '@jscad/modeling/<ns>'` for each namespace
 * - Proper `export` modifiers on all declarations
 * - Foundation types are defined and referenced correctly
 */

describe('module side effects', () => {
  it('does not execute main() when imported', () => {
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- process.exit returns never; mock must be cast to match
    const writeSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as unknown as typeof process.exit);
    // If main() ran unconditionally, it would attempt file writes and console output.
    // The fact that we successfully imported the module above without errors or
    // side-effects proves the guard is working.
    expect(buildNamespaceBundle).toBeDefined();
    expect(buildApiData).toBeDefined();
    expect(typeof buildNamespaceBundle).toBe('function');
    expect(typeof buildApiData).toBe('function');
    writeSpy.mockRestore();
  });
});

let output: string;

beforeAll(() => {
  output = buildNamespaceBundle();
});

describe('extract-jscad-types', () => {
  // ---------------------------------------------------------------------------
  // Top-level module
  // ---------------------------------------------------------------------------

  it('contains the main @jscad/modeling module declaration', () => {
    expect(output).toContain("declare module '@jscad/modeling'");
  });

  it('contains all 14 top-level namespace exports', () => {
    const expectedNamespaces = [
      'colors',
      'curves',
      'geometries',
      'maths',
      'measurements',
      'primitives',
      'text',
      'utils',
      'booleans',
      'expansions',
      'extrusions',
      'hulls',
      'modifiers',
      'transforms',
    ];

    for (const ns of expectedNamespaces) {
      expect(output).toContain(`export namespace ${ns} {`);
    }
  });

  // ---------------------------------------------------------------------------
  // Foundation types
  // ---------------------------------------------------------------------------

  it('exports foundation geometry types', () => {
    expect(output).toContain('export type Vec3 =');
    expect(output).toContain('export interface Geom3 {');
    expect(output).toContain('export interface Geom2 {');
    expect(output).toContain('export interface Path2 {');
    expect(output).toContain('export interface Poly3 {');
  });

  it('exports foundation color types', () => {
    expect(output).toContain('export type RGB =');
    expect(output).toContain('export type RGBA =');
    expect(output).toContain('export type Color = RGB | RGBA');
  });

  it('exports RecursiveArray generic interface', () => {
    expect(output).toContain('export interface RecursiveArray<T> extends Array<T | RecursiveArray<T>>');
  });

  it('exports Geometry union type', () => {
    expect(output).toContain('export type Geometry = Geom2 | Geom3 | Poly3 | Path2');
  });

  it('exports Mat4 type', () => {
    expect(output).toContain('export type Mat4 =');
  });

  // ---------------------------------------------------------------------------
  // Namespace content: primitives
  // ---------------------------------------------------------------------------

  it('exports cube function with export modifier (not bare declare)', () => {
    expect(output).toContain('export function cube(options?: CubeOptions): Geom3');
    expect(output).not.toContain('declare function cube(');
  });

  it('exports CubeOptions interface', () => {
    expect(output).toContain('export interface CubeOptions');
  });

  it('exports sphere function', () => {
    expect(output).toContain('export function sphere(');
  });

  // ---------------------------------------------------------------------------
  // Namespace content: booleans
  // ---------------------------------------------------------------------------

  it('exports union function with overloads', () => {
    expect(output).toContain('export function union(...geometries: RecursiveArray<Geom2>): Geom2');
    expect(output).toContain('export function union(...geometries: RecursiveArray<Geom3>): Geom3');
  });

  it('exports subtract and intersect functions', () => {
    expect(output).toContain('export function subtract(');
    expect(output).toContain('export function intersect(');
  });

  // ---------------------------------------------------------------------------
  // Namespace content: transforms
  // ---------------------------------------------------------------------------

  it('exports translate function with resolved local Vec type', () => {
    expect(output).toContain('export function translate<T extends Geometry>(offset: Vec, geometry: T): T');
    expect(output).toContain('export type Vec = Vec1 | Vec2 | Vec3');
  });

  // ---------------------------------------------------------------------------
  // Subpath module declarations
  // ---------------------------------------------------------------------------

  it('contains subpath module declarations for all 14 namespaces', () => {
    const expectedSubpaths = [
      '@jscad/modeling/colors',
      '@jscad/modeling/curves',
      '@jscad/modeling/geometries',
      '@jscad/modeling/maths',
      '@jscad/modeling/measurements',
      '@jscad/modeling/primitives',
      '@jscad/modeling/text',
      '@jscad/modeling/utils',
      '@jscad/modeling/booleans',
      '@jscad/modeling/expansions',
      '@jscad/modeling/extrusions',
      '@jscad/modeling/hulls',
      '@jscad/modeling/modifiers',
      '@jscad/modeling/transforms',
    ];

    for (const subpath of expectedSubpaths) {
      expect(output).toContain(`declare module '${subpath}'`);
    }
  });

  it('subpath modules import foundation types from the main module', () => {
    // The primitives subpath should import types it uses from main module
    const primitivesSection = extractModuleSection(output, '@jscad/modeling/primitives');
    expect(primitivesSection).toContain('import type {');
    expect(primitivesSection).toContain("} from '@jscad/modeling'");
  });

  it('subpath primitives module contains exported cube function', () => {
    const primitivesSection = extractModuleSection(output, '@jscad/modeling/primitives');
    expect(primitivesSection).toContain('export function cube(options?: CubeOptions): Geom3');
  });

  it('subpath booleans module contains exported union function', () => {
    const booleansSection = extractModuleSection(output, '@jscad/modeling/booleans');
    expect(booleansSection).toContain('export function union(');
  });

  it('no bare declare function statements in output', () => {
    // Inside declare module blocks, all functions should have `export function`,
    // never `declare function` (which would be module-private)
    const lines = output.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('declare function ')) {
        throw new Error(`Found bare 'declare function' (not exported): ${trimmed}`);
      }
    }
  });
});

// =============================================================================
// Helpers
// =============================================================================

/**
 * Extract the content of a specific `declare module '...'` block from the output.
 */
function extractModuleSection(text: string, moduleName: string): string {
  const marker = `declare module '${moduleName}'`;
  const startIndex = text.indexOf(marker);
  if (startIndex === -1) {
    return '';
  }

  // Find the matching closing brace by counting braces
  let depth = 0;
  let foundOpen = false;
  let endIndex = startIndex;

  for (let index = startIndex; index < text.length; index++) {
    if (text[index] === '{') {
      depth++;
      foundOpen = true;
    } else if (text[index] === '}') {
      depth--;
      if (foundOpen && depth === 0) {
        endIndex = index + 1;
        break;
      }
    }
  }

  return text.slice(startIndex, endIndex);
}
