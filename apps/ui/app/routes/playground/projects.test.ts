import { describe, expect, it } from 'vitest';
import { projectExamples, projectMetadataSchema } from '#routes/playground/projects.js';

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
    expect(example?.presets).toHaveLength(3);
    expect(example?.sourceFiles).toHaveProperty('main.ts', example?.code);
  });
});
