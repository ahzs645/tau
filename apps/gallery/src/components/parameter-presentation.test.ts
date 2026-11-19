import { describe, expect, it } from 'vitest';
import type { JSONSchema7 } from '@taucad/json-schema';
import { resolveGalleryParameters } from '#runtime/parameters.js';
import { mergeParameterChanges } from '#components/parameter-values.js';
import { projectGalleryParameters } from '#components/parameter-presentation.js';

const modelGroup = 'Model';
const stampGroup = 'Stamp';
const componentParameter = 'component_selection';
const defaults = { [modelGroup]: { [componentParameter]: 'stamp' }, [stampGroup]: { width: 30, height: 10 } };
const schema: JSONSchema7 = {
  type: 'object',
  required: [modelGroup, stampGroup],
  properties: {
    [modelGroup]: {
      type: 'object',
      required: [componentParameter],
      properties: { [componentParameter]: { type: 'string', enum: ['stamp', 'handle'] } },
    },
    [stampGroup]: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } } },
  },
};

describe('gallery parameter presentation', () => {
  it('should display inherited flat presets in the native parameter groups', () => {
    const view = projectGalleryParameters({ defaultParameters: defaults, jsonSchema: schema }, { width: 42 });
    expect(view.parameters).toEqual({
      [modelGroup]: { [componentParameter]: 'stamp' },
      [stampGroup]: { width: 42, height: 10 },
    });
  });

  it('should present one component selector while retaining every other field and its default', () => {
    const view = projectGalleryParameters(
      { defaultParameters: defaults, jsonSchema: schema },
      { [componentParameter]: 'handle', width: 42 },
      componentParameter,
    );
    expect(view.componentValue).toBe('handle');
    expect(view.parameters).toEqual({ [stampGroup]: { width: 42, height: 10 } });
    expect(view.defaultParameters).toEqual({ [stampGroup]: { width: 30, height: 10 } });
    expect(view.jsonSchema?.properties).toEqual({ [stampGroup]: schema.properties?.[stampGroup] });
    expect(view.jsonSchema?.required).toEqual([stampGroup]);
    expect(defaults[modelGroup][componentParameter]).toBe('stamp');
    expect(schema.required).toEqual([modelGroup, stampGroup]);
  });

  it('should let a grouped edit replace a legacy flat override without resetting the selected component', () => {
    const current = resolveGalleryParameters(defaults, { [componentParameter]: 'handle', width: 42 });
    const edited = mergeParameterChanges(current, {
      base: { [stampGroup]: { width: 42 } },
      next: { [stampGroup]: { width: 45 } },
    });
    expect(resolveGalleryParameters(defaults, edited)).toEqual({
      [modelGroup]: { [componentParameter]: 'handle' },
      [stampGroup]: { width: 45, height: 10 },
    });
    expect(edited).not.toHaveProperty('width');
  });
});
