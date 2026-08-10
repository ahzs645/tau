/* eslint-disable @typescript-eslint/naming-convention -- OpenSCAD customiser parameters keep their authored names as object keys */
import { describe, expect, it } from 'vitest';
import { loadProjectExample } from '#routes/playground/projects.js';
import { deriveStaticParameterView } from '#routes/playground/static-parameters.js';

describe('static parameter derivation', () => {
  it('uses the OpenSCAD kernel customizer parser when it accepts the source', async () => {
    const example = await loadProjectExample('3d-rack-scad');
    expect(example).toBeDefined();

    const view = deriveStaticParameterView(example!);
    const properties = view.jsonSchema.properties ?? {};

    // Real customizer groups (`/* [Rack Dimensions] */`) instead of the
    // name-prefix guesses the local inference falls back to.
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(['Rack Dimensions', 'Hole Configuration', 'Component Selection']),
    );
    expect(properties).not.toHaveProperty('Hidden');

    const rackDimensions = properties['Rack Dimensions'];
    expect(typeof rackDimensions === 'object' && rackDimensions.type).toBe('object');
  });

  it('round-trips grouped ui parameters back to the flat model shape', async () => {
    const example = await loadProjectExample('3d-rack-scad');
    const view = deriveStaticParameterView(example!);

    const flat = view.toModelParameters(view.defaultParameters);
    // The kernel injects parameters flat (`-D name=value`), so the model shape
    // must stay ungrouped even though the form is grouped.
    expect(Object.values(flat).some((value) => typeof value === 'object' && value !== null)).toBe(false);
    expect(view.toUiParameters(flat)).toEqual(view.defaultParameters);
  });

  it('groups presets the same way as the defaults', async () => {
    const example = await loadProjectExample('3d-rack-scad');
    const view = deriveStaticParameterView(example!);

    expect(view.presets.length).toBeGreaterThan(0);
    for (const preset of view.presets) {
      expect(view.toModelParameters(preset.parameters)).not.toEqual({});
    }
  });

  it('falls back to source inference when the kernel parser declines', async () => {
    // The periodic-table model (an interlocking-box system) has computed globals
    // (`BoxWidth = (BoxWidthUnits>0) ? …`), which the kernel's cheap parser
    // refuses; the static build has no wasm to fall back to, so local inference
    // still has to produce a usable form.
    const example = await loadProjectExample('periodic-table');
    expect(example).toBeDefined();

    const view = deriveStaticParameterView(example!);
    const flat = view.toModelParameters(view.defaultParameters);
    expect(flat).toMatchObject({ BoxUnits: 40, BoxHeight: 40 });
    expect(view.toUiParameters(flat)).toEqual(view.defaultParameters);
  });

  it('infers parameters from a TypeScript project defaultParams literal', async () => {
    const example = await loadProjectExample('pet-bottle-opener');
    expect(example).toBeDefined();

    const view = deriveStaticParameterView(example!);
    expect(Object.keys(view.jsonSchema.properties ?? {}).length).toBeGreaterThan(0);
    expect(view.toUiParameters(view.toModelParameters(view.defaultParameters))).toEqual(view.defaultParameters);
  });
});
