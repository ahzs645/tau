import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createKernelParameterDeclaration } from '@taucad/runtime/kernel';
import { parseClassicCustomizer } from '#runtime/classic/customizer.js';
import { classicParameterArguments, classicParameterDeclaration } from '#runtime/classic/parameters.js';
import { resolveGalleryParameters } from '#runtime/parameters.js';

const identity = { id: 'urn:gallery:classic-resolution-fixture', name: 'ClassicResolutionFixture' };

const declarationWithValues = (values: Readonly<Record<string, unknown>>) => {
  const { jsonSchema } = classicParameterDeclaration({ title: 'main.scad', parameters: [] });
  return createKernelParameterDeclaration(values, jsonSchema, identity);
};

describe('classic OpenSCAD resolution overrides', () => {
  it('should admit only explicit numeric resolution overrides without injecting model defaults', () => {
    const parsed = parseClassicCustomizer('smoothness = 12;\n$fn = smoothness;\n$fa = 8;\n$fs = 0.5;', 'main.scad');
    if (!parsed) {
      throw new Error('Expected authored resolution assignments.');
    }
    const declaration = classicParameterDeclaration(parsed);
    expect(declaration.defaultParameters).toEqual({ smoothness: 12 });
    expect(() => declarationWithValues({})).not.toThrow();
    expect(() => declarationWithValues({ $fn: 0 })).not.toThrow();
    expect(() => declarationWithValues({ $fn: 100, $fa: 1, $fs: 0.25 })).not.toThrow();
    expect(classicParameterArguments({ $fn: 100, $fa: 1, $fs: 0.25 })).toEqual(['-D$fn=100', '-D$fa=1', '-D$fs=0.25']);
  });

  it.each(['$fn', '$fa', '$fs'])('should reject nonfinite and nonnumeric %s values', (name) => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '100', null, true, []]) {
      expect(() => declarationWithValues({ [name]: value })).toThrow();
    }
  });

  it.each([{ $fn: -1 }, { $fn: 12.5 }, { $fa: 0 }, { $fa: -1 }, { $fs: 0 }, { $fs: -1 }])(
    'should reject resolution values outside their domain: %j',
    (values) => {
      expect(() => declarationWithValues(values)).toThrow();
    },
  );

  it.each(['$preview', '$t', '$arbitrary'])('should continue rejecting undeclared special control %s', (name) => {
    expect(() => declarationWithValues({ [name]: 1 })).toThrow();
  });

  it.each([
    { project: 'pendant-lamp', entry: 'Main.scad', names: ['Small', 'Medium', 'Large'] },
    { project: 'vane-trap', entry: 'main.scad', names: ['New set 1'] },
  ])('should admit the preserved $project presets without dropping $fn', async ({ project, entry, names }) => {
    const directory = new URL(`../../../models/projects/${project}/`, import.meta.url);
    const [source, presetText] = await Promise.all([
      readFile(new URL(entry, directory), 'utf8'),
      readFile(new URL('presets.json', directory), 'utf8'),
    ]);
    const parsed = parseClassicCustomizer(source, entry);
    if (!parsed) {
      throw new Error(`Expected a Customizer declaration for ${project}.`);
    }
    const declaration = classicParameterDeclaration(parsed);
    const decoded: unknown = JSON.parse(presetText);
    const presets = z
      .array(z.object({ name: z.string(), parameters: z.record(z.string(), z.unknown()) }))
      .parse(decoded);
    expect(presets.map(({ name }) => name)).toEqual(names);
    for (const preset of presets) {
      const values = resolveGalleryParameters(declaration.defaultParameters, preset.parameters);
      expect(values['$fn']).toBe(100);
      expect(() => createKernelParameterDeclaration(values, declaration.jsonSchema, identity)).not.toThrow();
    }
  });
});
