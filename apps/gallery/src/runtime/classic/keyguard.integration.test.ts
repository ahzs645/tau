import { describe, expect, it } from 'vitest';
import { createNodeGallerySession } from '#runtime/node.js';
import { loadNodeProjectFiles, readNodeCatalog } from '#scripts/catalog-node.js';
import { measureGlb } from '#scripts/measure-glb.js';
import { validateExportArtifact } from '#scripts/verification-artifacts.js';

describe('preserved keyguard frame configuration', { timeout: 60_000 }, () => {
  it('should explain the contradictory saved frame preset and render when the frame is explicitly enabled', async () => {
    const catalogue = await readNodeCatalog();
    const entry = catalogue.find(({ project }) => project.id === 'keyguard-with-raised-tabs');
    const variant = entry?.project.variants.find(({ id }) => id === 'openscad');
    const preset = entry?.project.presets.find(({ id }) => id === 'preset-2');
    if (!entry || !variant || !preset) {
      throw new Error('Missing the preserved keyguard frame preset.');
    }
    expect(preset.name).toBe('New set 2');
    expect(preset.parameters['generate']).toBe('keyguard frame');
    expect(preset.parameters['have_a_case']).toBe('yes');
    expect(preset.parameters['have_a_keyguard_frame']).toBe('no');
    const session = await createNodeGallerySession({
      kernel: variant.kernel,
      entryPath: variant.entry,
      files: await loadNodeProjectFiles(entry),
    });
    try {
      await expect(session.render(preset.parameters)).rejects.toThrow(
        'Keyguard frame output requires Have a case and Have a keyguard frame set to yes. Enable both, or choose keyguard output.',
      );
      // eslint-disable-next-line @typescript-eslint/naming-convention -- Enable the authored OpenSCAD flag without changing saved presets or dimensions.
      const enabled = await session.render({ ...preset.parameters, have_a_keyguard_frame: 'yes' });
      expect(enabled.issues.some(({ severity }) => severity === 'error')).toBe(false);
      if (typeof enabled.artifact.content === 'string') {
        throw new TypeError('Expected binary GLB frame geometry.');
      }
      const reference = await measureGlb(enabled.artifact.content);
      expect(reference.triangles).toBeGreaterThan(0);
      expect(reference.surfaceAreaMm2).toBeGreaterThan(0);
      const files = await session.export('stl');
      const validation = await validateExportArtifact({ format: 'stl', files, reference });
      expect(validation.level).toBe('geometry');
      expect(validation.counts['triangles']).toBeGreaterThan(0);
    } finally {
      await session.dispose();
    }
  });
});
