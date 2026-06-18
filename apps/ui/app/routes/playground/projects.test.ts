import { describe, expect, it } from 'vitest';
import { projectExamples, projectMetadataSchema, projectPresetsSchema } from '#routes/playground/projects.js';

describe('project examples discovery', () => {
  it('validates project metadata before building examples', () => {
    expect(
      projectMetadataSchema.safeParse({
        title: 'Bad project',
        description: 'Missing entry should fail clearly.',
      }).success,
    ).toBe(false);

    expect(
      projectMetadataSchema.safeParse({
        title: 'Valid project',
        entry: 'main.scad',
        description: 'A valid OpenSCAD gallery project.',
        exportFormats: ['glb', 'stl'],
        previewGlb: 'preview.glb',
      }).success,
    ).toBe(true);

    expect(
      projectMetadataSchema.safeParse({
        title: 'Valid project',
        entry: 'main.scad',
        description: 'A valid OpenSCAD gallery project.',
        staticPreview: { glb: 'preview.glb' },
      }).success,
    ).toBe(true);
  });

  it('builds playground examples from project folders', () => {
    const examplesById = new Map(projectExamples.map((example) => [example.id, example]));

    expect(examplesById.get('3d-rack-scad')).toMatchObject({
      name: '3D Rack System',
      kernel: 'OpenSCAD',
      mainFile: 'main.scad',
    });

    expect(examplesById.get('keyguard-with-raised-tabs')?.sourceFiles).toHaveProperty('openings_and_additions.txt');
    expect(examplesById.has('wham')).toBe(false);
  });

  it('keeps metadata-only fields from project.json', () => {
    const example = projectExamples.find((candidate) => candidate.id === 'pet-bottle-opener');

    expect(example).toMatchObject({
      name: 'Modular PET Bottle Opener (OpenCascade)',
      kernel: 'Replicad',
      mainFile: 'main.ts',
      language: 'typescript',
      initialParameters: { secondOpener: false },
    });
    expect(example?.exportFormats).toContain('step');
    expect(example?.presets).toHaveLength(5);
    expect(example?.sourceFiles).toHaveProperty('main.ts', example?.code);
    expect(example?.sourceFiles).not.toHaveProperty('presets.json');
  });

  it('validates separate project preset files', () => {
    expect(
      projectPresetsSchema.safeParse([
        {
          name: 'Wide',
          parameters: { width: 120, enabled: true },
        },
      ]).success,
    ).toBe(true);

    expect(
      projectPresetsSchema.safeParse([
        {
          name: '',
          parameters: { width: 120 },
        },
      ]).success,
    ).toBe(false);
  });

  it('carries OpenSCAD Playground preset sets into discovered project metadata', () => {
    const examplesById = new Map(projectExamples.map((example) => [example.id, example]));

    expect(examplesById.get('3d-rack-scad')?.presets?.map((preset) => preset.name)).toEqual(['New set 1', 'New set 2']);
    expect(examplesById.get('keyguard-with-raised-tabs')?.presets).toHaveLength(10);
    expect(examplesById.get('pendant-lamp')?.presets?.map((preset) => preset.name)).toEqual([
      'Small',
      'Medium',
      'Large',
    ]);
    expect(examplesById.get('periodic-table')?.presets?.map((preset) => preset.name)).toEqual([
      'type1_inner_box',
      'type2_top_edge',
      'type3_right_edge',
      'type4_bottom_edge',
      'type5_left_edge',
      'type6_corner_topleft',
      'type7_corner_topright',
      'type8_corner_bottomleft',
      'type9_corner_bottomright',
      'type10_lanthanide_left',
      'type11_lanthanide_middle',
      'type12_lanthanide_right',
      'type13_gap_spacer',
    ]);
    expect(examplesById.get('vane-trap')?.presets).toHaveLength(1);
  });

  it('normalizes imported OpenSCAD preset scalar values', () => {
    const examplesById = new Map(projectExamples.map((example) => [example.id, example]));
    const rackParameters = examplesById.get('3d-rack-scad')?.presets?.[0]?.parameters;
    const lampParameters = examplesById.get('pendant-lamp')?.presets?.[2]?.parameters;
    const keyguardParameters = examplesById.get('keyguard-with-raised-tabs')?.presets?.[0]?.parameters;

    expect(rackParameters?.['rack_width']).toBe(300);
    expect(rackParameters?.['enable_numbers']).toBe(true);
    expect(rackParameters?.['component_selection']).toBe('assembly');
    expect(lampParameters?.['$fn']).toBe(100);
    expect(lampParameters?.['top_brim']).toBe(false);
    expect(lampParameters?.['radius']).toBe(177.88);
    expect(keyguardParameters?.['number_of_columns']).toBe(4);
    expect(keyguardParameters?.['add_circular_opening']).toBe('yes');
    expect(keyguardParameters?.['Braille_text']).toBe('');
  });
});
