import { describe, expect, it } from 'vitest';
import {
  loadProjectExample,
  projectExamples,
  projectMetadataSchema,
  projectPresetsSchema,
} from '#routes/playground/projects.js';

describe('project uploads', () => {
  it('accepts a complete upload declaration', () => {
    expect(
      projectMetadataSchema.safeParse({
        title: 'Uploadable project',
        entry: 'main.scad',
        description: 'Takes viewer-supplied artwork.',
        uploads: [{ parameter: 'svg_file', fileName: 'artwork.svg', accept: '.svg', label: 'Artwork (SVG)' }],
      }).success,
    ).toBe(true);
  });

  it('leaves uploads undefined for projects that do not declare one', () => {
    // No project declares an upload yet: the OpenSCAD kernel mounts only the
    // .scad files it discovers through include/use, so an uploaded asset never
    // reaches the render. See docs/research/playground-asset-uploads.md.
    const vaneTrap = projectExamples.find((example) => example.id === 'vane-trap');
    expect(vaneTrap?.uploads).toBeUndefined();
    expect(projectExamples.every((example) => example.uploads === undefined)).toBe(true);
  });

  it('rejects an upload declaration missing its parameter binding', () => {
    expect(
      projectMetadataSchema.safeParse({
        title: 'Bad upload',
        entry: 'main.scad',
        description: 'Upload without a parameter to point at.',
        uploads: [{ fileName: 'artwork.svg', accept: '.svg', label: 'Artwork' }],
      }).success,
    ).toBe(false);
  });
});

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

    expect(
      projectMetadataSchema.safeParse({
        title: 'Static project',
        entry: 'preview.glb',
        type: 'static',
        description: 'A static gallery project.',
      }).success,
    ).toBe(true);
  });

  it('builds a lightweight catalog and loads project source on demand', async () => {
    const examplesById = new Map(projectExamples.map((example) => [example.id, example]));
    const keyguard = await loadProjectExample('keyguard-with-raised-tabs');

    expect(examplesById.get('3d-rack-scad')).toMatchObject({
      name: '3D Rack System',
      kernel: 'OpenSCAD',
      mainFile: 'main.scad',
    });

    expect(examplesById.get('keyguard-with-raised-tabs')?.sourceFiles).toBeUndefined();
    expect(keyguard?.sourceFiles).toHaveProperty('openings_and_additions.txt');
    expect(examplesById.get('atmospheric-sampler')).toMatchObject({
      name: 'Atmospheric Sampler',
      kernel: 'Static',
      mode: 'static',
      mainFile: 'atmospheric-sampler.glb',
      language: 'gltf',
      exportFormats: [],
      code: '',
      sourceFiles: {},
    });
    expect(examplesById.get('atmospheric-sampler')?.staticPreview).toBeDefined();
    expect(examplesById.get('pre-chamber-nozzle-insert')?.staticPreview).toBeDefined();
    expect(examplesById.has('wham')).toBe(false);
  });

  it('keeps metadata-only fields in the catalog and materializes source lazily', async () => {
    const catalogExample = projectExamples.find((candidate) => candidate.id === 'pet-bottle-opener');
    const example = await loadProjectExample('pet-bottle-opener');

    expect(catalogExample).toMatchObject({
      name: 'Modular PET Bottle Opener (OpenCascade)',
      kernel: 'Replicad',
      mainFile: 'main.ts',
      language: 'typescript',
      initialParameters: { lower: { module: 'none' } },
    });
    expect(catalogExample?.code).toBe('');
    expect(catalogExample?.sourceFiles).toBeUndefined();
    expect(example?.exportFormats).toContain('step');
    expect(example?.presets).toHaveLength(7);
    expect(example?.sourceFiles).toHaveProperty('main.ts', example?.code);
    expect(example?.sourceFiles).toHaveProperty('lib/melded-neck.ts');
    expect(example?.sourceFiles).not.toHaveProperty('presets.json');
    // Projects own their source locally: the loader reads main.ts straight
    // from this project folder.
    expect(example?.code).toContain('Modular PET Bottle Opener');
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
