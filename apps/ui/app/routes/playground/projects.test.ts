import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadProjectExample,
  parseUploadAccept,
  projectExamples,
  projectMetadataSchema,
  projectPresetsSchema,
} from '#routes/playground/projects.js';

describe('project uploads', () => {
  it('accepts a declaration that points a parameter at the uploaded file', () => {
    expect(
      projectMetadataSchema.safeParse({
        title: 'Uploadable project',
        entry: 'main.scad',
        description: 'Takes viewer-supplied artwork.',
        uploads: [
          { parameter: 'svg_file', fileName: 'artwork.svg', accept: '.svg,image/svg+xml', label: 'Artwork (SVG)' },
        ],
      }).success,
    ).toBe(true);
  });

  it('accepts a declaration without a parameter, for a model that reads a fixed name', () => {
    expect(
      projectMetadataSchema.safeParse({
        title: 'Uploadable project',
        entry: 'main.occt.ts',
        description: 'Reads its artwork through a fixed `?raw` import.',
        uploads: [{ fileName: 'artwork.svg', accept: '.svg,image/svg+xml', label: 'Artwork (SVG)' }],
      }).success,
    ).toBe(true);
  });

  it('rejects an accept string with no MIME type to match on', () => {
    expect(
      projectMetadataSchema.safeParse({
        title: 'Bad upload',
        entry: 'main.scad',
        description: 'Extension-only accept matches nothing in the drop zone.',
        uploads: [{ fileName: 'artwork.svg', accept: '.svg', label: 'Artwork' }],
      }).success,
    ).toBe(false);
  });

  it('surfaces the stamp declaration the artwork drop zone renders from', () => {
    // The stamp's artwork is the one asset a viewer is expected to bring, and
    // both its variants read it as `yaa.svg` — the OpenSCAD `svg_file` default
    // and the OpenCASCADE `./yaa.svg?raw` import — so replacing that file is
    // the whole binding and no parameter needs pointing at it.
    const stamp = projectExamples.find((example) => example.id === 'stamp');
    expect(stamp?.uploads).toStrictEqual([
      { fileName: 'yaa.svg', accept: '.svg,image/svg+xml', label: 'Artwork (SVG)' },
    ]);
  });

  it('leaves uploads undefined for projects that do not declare one', () => {
    const vaneTrap = projectExamples.find((example) => example.id === 'vane-trap');
    expect(vaneTrap?.uploads).toBeUndefined();
  });

  /* eslint-disable @typescript-eslint/naming-convention -- keys are MIME types, not identifiers */
  it('maps an accept string onto every declared MIME type', () => {
    expect(parseUploadAccept('.svg,image/svg+xml')).toStrictEqual({ 'image/svg+xml': ['.svg'] });
    expect(parseUploadAccept('.dxf,.svg,image/svg+xml,image/vnd.dxf')).toStrictEqual({
      'image/svg+xml': ['.dxf', '.svg'],
      'image/vnd.dxf': ['.dxf', '.svg'],
    });
    expect(parseUploadAccept('.svg')).toBeUndefined();
  });
  /* eslint-enable @typescript-eslint/naming-convention -- MIME-type keys are back out of scope */
});

describe('project binary assets', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('carries a mesh as bytes while its sources stay text', async () => {
    // A binary STL cannot come through the `?raw` text loader — decoding it as
    // UTF-8 corrupts it — so it is fetched from its emitted URL instead. Both
    // shapes end up in the same `sourceFiles` record, because the preview
    // filesystem takes bytes either way.
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([0x53, 0x54, 0x4c, 0x42])));

    const stamp = await loadProjectExample('stamp');
    const handle = stamp?.sourceFiles?.['stamp_template_handle.stl'];

    expect(ArrayBuffer.isView(handle)).toBe(true);
    expect((handle as Uint8Array<ArrayBuffer>).byteLength).toBe(4);
    expect(typeof stamp?.sourceFiles?.['Main.scad']).toBe('string');
    expect(typeof stamp?.sourceFiles?.['yaa.svg']).toBe('string');
  });

  it('drops an asset it cannot fetch instead of failing the whole project', async () => {
    // Losing the knub is a model that renders without it; throwing here would
    // be a project that does not open at all.
    globalThis.fetch = vi.fn(async () => new Response(undefined, { status: 404 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const stamp = await loadProjectExample('stamp');

    expect(stamp?.sourceFiles?.['stamp_template_handle.stl']).toBeUndefined();
    expect(typeof stamp?.code).toBe('string');
    expect(warn).toHaveBeenCalled();
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
