import { describe, expect, it } from 'vitest';
import { parseOpenScadCustomizerParameters, processOpenScadParameters } from '#parse-parameters.js';

/* eslint-disable @typescript-eslint/naming-convention -- OpenSCAD parameters conventionally use snake_case */

describe('parseOpenScadCustomizerParameters', () => {
  it('parses 3D rack customizer groups, descriptions, ranges, booleans, and enums', () => {
    const parsed = parseOpenScadCustomizerParameters(
      `
include <BOSL2/std.scad>

/*[Rack Dimensions]*/
rack_width = 201;
rack_depth = 222.4;

/*[Plate Configuration]*/
// Number of plates (minimum 1)
num_plates = 3;  // [1:10] // Customize min and max as needed

/*[Hole Configuration]*/
hole_diameter = 16;     //// [1.0:1.0:100.0] Diameter of holes

/*[Hole Numbering Configuration]*/
// Enable hole numbering
enable_numbers = true;  // [true,false]
// Depth of number indents
number_depth = 3;  // [0.5:0.1:4]

/*[Dovetail Configuration]*/
support_thickness = 14.3;

/*[Handle Configuration]*/
handle_width = support_thickness;  // Match support thickness

/*[Vertical Support Dovetail Configuration]*/
dovetail_count = num_plates + 1;  // One more dovetail than plates for secure assembly

/*[Component Selection]*/
// Combo box to select which component to render
component_selection = "assembly"; // [assembly:Assembly, bottom_rack:Bottom Rack, combined_rack:Combined Rack, vertical_support:Vertical Support]

module depth_dovetail_profile(side, width, height, back_width) {
  polygon([]);
}
`,
      'main.scad',
    );

    expect(parsed).toEqual({
      title: 'main.scad',
      parameters: [
        {
          group: 'Rack Dimensions',
          initial: 201,
          name: 'rack_width',
          type: 'number',
        },
        {
          group: 'Rack Dimensions',
          initial: 222.4,
          name: 'rack_depth',
          type: 'number',
        },
        {
          caption: 'Number of plates (minimum 1)',
          group: 'Plate Configuration',
          initial: 3,
          max: 10,
          min: 1,
          name: 'num_plates',
          step: 1,
          type: 'number',
        },
        {
          caption: 'Diameter of holes',
          group: 'Hole Configuration',
          initial: 16,
          max: 100,
          min: 1,
          name: 'hole_diameter',
          step: 1,
          type: 'number',
        },
        {
          caption: 'Enable hole numbering',
          group: 'Hole Numbering Configuration',
          initial: true,
          name: 'enable_numbers',
          type: 'boolean',
        },
        {
          caption: 'Depth of number indents',
          group: 'Hole Numbering Configuration',
          initial: 3,
          max: 4,
          min: 0.5,
          name: 'number_depth',
          step: 0.1,
          type: 'number',
        },
        {
          group: 'Dovetail Configuration',
          initial: 14.3,
          name: 'support_thickness',
          type: 'number',
        },
        {
          caption: 'Match support thickness',
          group: 'Handle Configuration',
          initial: 14.3,
          name: 'handle_width',
          type: 'number',
        },
        {
          caption: 'One more dovetail than plates for secure assembly',
          group: 'Vertical Support Dovetail Configuration',
          initial: 4,
          name: 'dovetail_count',
          type: 'number',
        },
        {
          caption: 'Combo box to select which component to render',
          group: 'Component Selection',
          initial: 'assembly',
          name: 'component_selection',
          options: [
            { name: 'Assembly', value: 'assembly' },
            { name: 'Bottom Rack', value: 'bottom_rack' },
            { name: 'Combined Rack', value: 'combined_rack' },
            { name: 'Vertical Support', value: 'vertical_support' },
          ],
          type: 'string',
        },
      ],
    });
  });

  it('produces the schema shape consumed by the existing OpenSCAD parameter processor', () => {
    const parsed = parseOpenScadCustomizerParameters(`
/*[Component Selection]*/
component_selection = "assembly"; // [assembly:Assembly, bottom_rack:Bottom Rack]
`);

    expect(processOpenScadParameters(parsed!)).toEqual({
      type: 'object',
      properties: {
        'Component Selection': {
          type: 'object',
          title: 'Component Selection',
          properties: {
            component_selection: {
              type: 'string',
              title: 'component_selection',
              default: 'assembly',
              oneOf: [
                { const: 'assembly', title: 'Assembly' },
                { const: 'bottom_rack', title: 'Bottom Rack' },
              ],
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });
  });

  it('returns undefined so the kernel can fall back when a leading assignment is not safely parseable', () => {
    expect(
      parseOpenScadCustomizerParameters(`
size = lookup_size();
cube([size, size, size]);
`),
    ).toBeUndefined();
  });

  it('stops at executable body code instead of parsing derived declarations later in the file', () => {
    const parsed = parseOpenScadCustomizerParameters(`
width = 10;
cube([width, width, width]);
derived = unknown_function();
`);

    expect(parsed?.parameters.map((parameter) => parameter.name)).toEqual(['width']);
  });
});

/* eslint-enable @typescript-eslint/naming-convention -- re-enable after OpenSCAD parameter tests */
