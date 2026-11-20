import { describe, expect, it } from 'vitest';
import { createKernelParameterDeclaration } from '@taucad/runtime/kernel';
import { parseClassicCustomizer } from '#runtime/classic/customizer.js';
import { classicParameterDeclaration } from '#runtime/classic/parameters.js';
import { parameterExportSchema } from '#runtime/classic/parameter-types.js';

const options = [
  { value: 1, name: '10mm -3/8 in- Dots' },
  { value: 2, name: '16mm -5/8 in- Dots' },
  { value: 3, name: '20mm -3/4 in- Dots' },
  { value: 4, name: '3/8 in Squares' },
  { value: 5, name: '5/8 in Squares' },
  { value: 6, name: '3/4 in Squares' },
];

const source = `/*[Velcro Info]*/
velcro_size = 1; // [1:10mm -3/8 in- Dots, 2:16mm -5/8 in- Dots, 3:20mm -3/4 in- Dots, 4:3/8 in Squares, 5:5/8 in Squares, 6:3/4 in Squares]`;

describe('classic numeric Customizer choices', () => {
  it.each(['native', 'source'] as const)(
    'should admit every original keyguard choice from the %s parser with its label and numeric identity',
    (parser) => {
      // This native export is the exact velcro_size record emitted by the pinned original engine.
      const exported =
        parser === 'native'
          ? parameterExportSchema.parse({
              title: 'main',
              parameters: [{ group: 'Velcro Info', initial: 1, name: 'velcro_size', type: 'number', options }],
            })
          : parseClassicCustomizer(source, 'main.scad');
      if (!exported) {
        throw new Error('Expected the original keyguard numeric dropdown.');
      }
      const { defaultParameters, jsonSchema } = classicParameterDeclaration(exported);
      // eslint-disable-next-line @typescript-eslint/naming-convention -- velcro_size is the original model's external parameter name.
      expect(defaultParameters).toEqual({ 'Velcro Info': { velcro_size: 1 } });
      expect(jsonSchema).toMatchObject({
        properties: {
          'Velcro Info': {
            properties: {
              // eslint-disable-next-line @typescript-eslint/naming-convention -- The schema must retain the authored velcro_size key.
              velcro_size: {
                type: 'number',
                enum: [1, 2, 3, 4, 5, 6],
                oneOf: options.map(({ value, name }) => ({ const: value, title: name })),
              },
            },
          },
        },
      });
      const declare = (value: unknown) =>
        // eslint-disable-next-line @typescript-eslint/naming-convention -- Admission consumes the original model's velcro_size key.
        createKernelParameterDeclaration({ 'Velcro Info': { velcro_size: value } }, jsonSchema, {
          id: 'urn:gallery:keyguard-numeric-choice-fixture',
          name: 'KeyguardNumericChoiceFixture',
        });
      for (const { value } of options) {
        expect(() => declare(value)).not.toThrow();
      }
      for (const value of [0, 7, 1.5, '6']) {
        expect(() => declare(value)).toThrow();
      }
    },
  );
});
