import { describe, expect, it } from 'vitest';
import { createKernelParameterDeclaration } from '@taucad/runtime/kernel';
import { parseClassicCustomizer } from '#runtime/classic/customizer.js';
import { parseCustomizerValue } from '#runtime/classic/expression.js';
import { classicParameterArguments, classicParameterDeclaration } from '#runtime/classic/parameters.js';
import { parameterExportSchema } from '#runtime/classic/parameter-types.js';

describe('classic OpenSCAD Customizer compatibility', () => {
  it('should accept the native empty export without accepting a malformed parameter collection', () => {
    expect(parameterExportSchema.parse({ title: 'main' })).toEqual({ title: 'main', parameters: [] });
    expect(parameterExportSchema.safeParse({ title: 'main', parameters: null }).success).toBe(false);
    expect(parameterExportSchema.safeParse({ title: 'main', parameters: {} }).success).toBe(false);
  });

  it('should preserve grouped controls, exact group keys, booleans, options, and source defaults', () => {
    const exported = parseClassicCustomizer(
      `/* [Tip / chamber] */
width = 12.5;
height = width * 2;
enable_center_dots = true; // [true,false]
mode = "print"; // [print:Printable, display:Display]
offset = [1, -2, 3];
/* [Model] */
component_selection = "stamp"; // [stamp:Stamp, handle:Handle]
/* [Hidden] */
svg_file = "artwork.svg";
$fn = 48;
module body() { cube([width,height,1]); }
body();`,
      'main.scad',
    );
    expect(exported).toBeDefined();
    if (!exported) {
      throw new Error('Expected Customizer parameters.');
    }
    const declaration = classicParameterDeclaration(exported);
    expect(declaration.defaultParameters).toEqual({
      'Tip / chamber': { width: 12.5, height: 25, enable_center_dots: true, mode: 'print', offset: [1, -2, 3] },
      Model: { component_selection: 'stamp' },
    });
    const identity = { id: 'urn:gallery:classic-customizer-fixture', name: 'ClassicCustomizerFixture' };
    expect(() =>
      createKernelParameterDeclaration(declaration.defaultParameters, declaration.jsonSchema, identity),
    ).not.toThrow();
    expect(() =>
      createKernelParameterDeclaration(
        {
          ...declaration.defaultParameters,
          Model: { component_selection: 'handle' },
          'Tip / chamber': { width: 12.5, height: 25, enable_center_dots: false, mode: 'display', offset: [1, -2, 3] },
        },
        declaration.jsonSchema,
        identity,
      ),
    ).not.toThrow();
  });

  it('should defer expressions outside the literal fast path to the native engine', () => {
    expect(parseClassicCustomizer('width = cos(30) * 10;\ncube(width);', 'main.scad')).toBeUndefined();
    expect(parseCustomizerValue('1 / 0', {})).toBeUndefined();
    expect(parseCustomizerValue('[1, sin(30), 3]', {})).toBeUndefined();
  });

  it('should round-trip quotes, backslashes, newlines, booleans, and numeric vectors as CLI values', () => {
    const text = 'A "quoted" \\ path\nnext line';
    expect(parseCustomizerValue(JSON.stringify(text), {})).toBe(text);
    expect(classicParameterArguments({ Group: { label: text, enabled: false, offset: [1, 2, -3] } })).toEqual([
      `-Dlabel=${JSON.stringify(text)}`,
      '-Denabled=false',
      '-Doffset=[1,2,-3]',
    ]);
    expect(() => classicParameterArguments({ bad: Number.NaN })).toThrow('finite');
  });
});
