import { describe, expect, it } from 'vitest';
import type { JSONSchema7 } from '@taucad/json-schema';
import { resolveGalleryParameters } from '#runtime/parameters.js';
import { mergeGalleryParameterChanges, projectConditionalParameters } from '#components/parameter-conditions.js';

const defaults = { lower: { module: 'none', hole: 25, radius: 17.5, cap: 19, spacing: 63 }, thickness: 14 };
const schema: JSONSchema7 = {
  type: 'object',
  properties: {
    thickness: { type: 'number', default: 14 },
    lower: {
      type: 'object',
      properties: { module: { type: 'string', enum: ['none', 'handle', 'opener'] } },
      additionalProperties: true,
      oneOf: [
        {
          type: 'object',
          properties: { module: { type: 'string', enum: ['none'], default: 'none' } },
          required: ['module'],
          additionalProperties: true,
        },
        {
          type: 'object',
          properties: {
            module: { type: 'string', enum: ['handle'], default: 'handle' },
            hole: { type: 'number', default: 25 },
            radius: { type: 'number', default: 17.5 },
            spacing: { type: 'number', default: 63 },
          },
          required: ['module'],
          additionalProperties: true,
        },
        {
          type: 'object',
          properties: {
            module: { type: 'string', enum: ['opener'], default: 'opener' },
            cap: { type: 'number', default: 19 },
            spacing: { type: 'number', default: 63 },
          },
          required: ['module'],
          additionalProperties: true,
        },
      ],
    },
  },
};
const description = { defaultParameters: defaults, jsonSchema: schema };

describe('conditional gallery parameters', () => {
  it('should omit inactive controls and their defaults from the form without changing saved values', () => {
    expect(projectConditionalParameters(schema, defaults, defaults)).toEqual({
      lower: { module: 'none' },
      thickness: 14,
    });
    const handle = resolveGalleryParameters(defaults, { lower: { module: 'handle', hole: 27 } });
    expect(projectConditionalParameters(schema, handle, handle)).toEqual({
      lower: { module: 'handle', hole: 27, radius: 17.5, spacing: 63 },
      thickness: 14,
    });
    expect(projectConditionalParameters(schema, defaults, handle)).toEqual({
      lower: { module: 'none', hole: 25, radius: 17.5, spacing: 63 },
      thickness: 14,
    });
    expect(defaults.lower.cap).toBe(19);
    expect(handle).toHaveProperty('lower.cap', 19);
  });

  it('should retain edited values when a branch is disabled and restore them when it is selected again', () => {
    const handle = resolveGalleryParameters(defaults, { lower: { module: 'handle', hole: 27, spacing: 70 } });
    const disabled = mergeGalleryParameterChanges(description, handle, {
      base: { lower: { module: 'handle', hole: 27, spacing: 70 } },
      next: {},
    });
    const current = resolveGalleryParameters(defaults, disabled);
    expect(current).toHaveProperty('lower.module', 'none');
    expect(current).toHaveProperty('lower.hole', 27);
    expect(current).toHaveProperty('lower.spacing', 70);
    const restored = mergeGalleryParameterChanges(description, current, {
      base: {},
      next: { lower: { module: 'handle' } },
    });
    expect(resolveGalleryParameters(defaults, restored)).toEqual(handle);
  });

  it('should restore a remembered field when RJSF writes the branch default over it', () => {
    const current = resolveGalleryParameters(defaults, { lower: { module: 'opener', hole: 27, cap: 22 } });
    const restored = mergeGalleryParameterChanges(description, current, {
      base: { lower: { module: 'opener', cap: 22 } },
      next: { lower: { module: 'handle', hole: 25 } },
    });
    expect(restored).toHaveProperty('lower.hole', 27);
    expect(restored).toHaveProperty('lower.cap', 22);
    expect(restored).toHaveProperty('lower.module', 'handle');
  });

  it('should allow an ordinary field reset without restoring the discarded override', () => {
    const current = resolveGalleryParameters(defaults, { lower: { module: 'handle', hole: 27 } });
    const reset = mergeGalleryParameterChanges(description, current, {
      base: { lower: { module: 'handle', hole: 27 } },
      next: { lower: { module: 'handle' } },
    });
    expect(reset).not.toHaveProperty('lower.hole');
    expect(resolveGalleryParameters(defaults, reset)).toHaveProperty('lower.hole', 25);
  });

  it('should preserve newer independent changes while a stale form changes the active branch', () => {
    const current = resolveGalleryParameters(defaults, {
      lower: { module: 'handle', hole: 29, spacing: 70 },
      thickness: 16,
    });
    const switched = mergeGalleryParameterChanges(description, current, {
      base: { lower: { module: 'handle', hole: 27, spacing: 63 }, thickness: 14 },
      next: { lower: { module: 'opener', cap: 19, spacing: 63 }, thickness: 14 },
    });
    expect(switched).toHaveProperty('lower.hole', 29);
    expect(switched).toHaveProperty('lower.spacing', 70);
    expect(switched).toHaveProperty('thickness', 16);
  });
});
