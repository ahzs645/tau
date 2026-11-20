import { describe, expect, it } from 'vitest';
import { admitJsonSchema, validateJsonSchemaIssues, validateJsonSchemaValue } from '@taucad/parameters/schema';

describe('gallery decimal multipleOf execution validation', () => {
  it.each(['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema'])(
    'should validate positive and negative decimal multiples symmetrically in %s',
    (dialect) => {
      const schema = { $schema: dialect, type: 'number', multipleOf: 0.1 };
      admitJsonSchema(schema);
      for (const magnitude of [0, 0.3, 0.7, 1, 2.8, 50]) {
        expect(validateJsonSchemaValue(schema, magnitude), String(magnitude)).toBe(true);
        expect(validateJsonSchemaValue(schema, -magnitude), String(-magnitude)).toBe(true);
      }
      for (const magnitude of [0.15, 1.05, 2.81]) {
        expect(validateJsonSchemaValue(schema, magnitude), String(magnitude)).toBe(false);
        expect(validateJsonSchemaValue(schema, -magnitude), String(-magnitude)).toBe(false);
      }
    },
  );

  it('should retain nested reference and combinator semantics around negative decimal values', () => {
    const schema = {
      type: 'object',
      definitions: { step: { type: 'number', minimum: -2, maximum: 2, multipleOf: 0.1 } },
      properties: {
        offset: { $ref: '#/definitions/step' },
        offsets: { type: 'array', items: { $ref: '#/definitions/step' } },
        choice: { oneOf: [{ $ref: '#/definitions/step' }, { type: 'null' }] },
      },
      required: ['offset', 'offsets', 'choice'],
      additionalProperties: false,
    };
    admitJsonSchema(schema);
    const values = { offset: -1, offsets: [-1, -0.3, 0, 0.3, 1], choice: -0.7 };
    expect(validateJsonSchemaValue(schema, values)).toBe(true);
    expect(validateJsonSchemaIssues(schema, values)).toEqual([]);
    expect(validateJsonSchemaValue(schema, { ...values, choice: null })).toBe(true);
    expect(validateJsonSchemaValue(schema, { ...values, choice: -0.75 })).toBe(false);
    expect(validateJsonSchemaValue(schema, { ...values, offset: -2.1 })).toBe(false);
    expect(validateJsonSchemaValue(schema, { ...values, offsets: [-0.35] })).toBe(false);
    expect(validateJsonSchemaValue(schema, { ...values, extra: -1 })).toBe(false);
    expect(validateJsonSchemaIssues(schema, { ...values, offset: -0.35 })).toContainEqual({
      pointer: '/offset',
      message: '-0.35 is not a multiple of 0.1.',
    });
  });
});
