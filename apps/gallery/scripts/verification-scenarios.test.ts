import { describe, expect, it } from 'vitest';
import { readNodeCatalog } from '#scripts/catalog-node.js';
import { verificationScenarios } from '#scripts/verification-scenarios.js';

describe('public gallery verification coverage', () => {
  it('should preserve the bounded defaults-only command when regressions are not requested', async () => {
    const entries = await readNodeCatalog();
    const catalogue = entries.filter(({ project }) => !project.hidden);
    const variants = catalogue.flatMap(({ project }) => project.variants.map((variant) => ({ project, variant })));
    expect(variants).toHaveLength(30);
    for (const { project, variant } of variants) {
      expect(verificationScenarios(project, variant, false)).toEqual([{ name: 'defaults' }]);
    }
    expect(catalogue.filter(({ project }) => project.mode === 'static')).toHaveLength(1);
  });

  it('should exercise every authored public preset on its default variant without duplicating special cases', async () => {
    const entries = await readNodeCatalog();
    const catalogue = entries.filter(({ project }) => !project.hidden);
    expect(catalogue.flatMap(({ project }) => project.presets)).toHaveLength(50);
    for (const { project } of catalogue) {
      for (const variant of project.variants) {
        const scenarios = verificationScenarios(project, variant, true);
        expect(new Set(scenarios.map(({ name }) => name)).size).toBe(scenarios.length);
        if (variant.id !== project.defaultVariantId) {
          expect(scenarios).toEqual([{ name: 'defaults' }]);
          continue;
        }
        for (const preset of project.presets) {
          if (project.id === 'bottle-separator') {
            expect(scenarios.filter(({ name }) => name.startsWith(`${preset.id}-`))).toHaveLength(2);
            expect(scenarios.find(({ name }) => name === `${preset.id}-standard`)?.parameters).toEqual({
              ...preset.parameters,
              'Bottle fit': {},
            });
          } else {
            expect(scenarios.filter(({ name }) => name === preset.id)).toHaveLength(1);
            expect(scenarios.find(({ name }) => name === preset.id)?.parameters).toEqual(preset.parameters);
          }
        }
      }
    }
  });

  it('should require all 93 public cases and 378 positive export requests for the full command', async () => {
    const entries = await readNodeCatalog();
    const catalogue = entries.filter(({ project }) => !project.hidden);
    const cases = catalogue.flatMap(({ project }) =>
      project.variants.flatMap((variant) =>
        verificationScenarios(project, variant, true).map((scenario) => ({ project, variant, scenario })),
      ),
    );
    const staticCount = catalogue.filter(({ project }) => project.mode === 'static').length;
    expect(cases.length + staticCount).toBe(93);
    const rejections = cases.filter(({ scenario }) => scenario.expectedError !== undefined);
    expect(rejections.map(({ project, scenario }) => `${project.id}/${scenario.name}`).sort()).toEqual([
      'bottle-separator/bed-too-small',
      'bottle-separator/invalid-bottle-gap',
      'keyguard-with-raised-tabs/preset-2',
    ]);
    const keyguardRejection = rejections.find(({ project }) => project.id === 'keyguard-with-raised-tabs');
    expect(keyguardRejection?.scenario.expectedError).toBe(
      'Keyguard frame output requires Have a case and Have a keyguard frame set to yes. Enable both, or choose keyguard output.',
    );
    expect(keyguardRejection?.scenario.parameters?.['generate']).toBe('keyguard frame');
    expect(keyguardRejection?.scenario.parameters?.['have_a_keyguard_frame']).toBe('no');
    expect(cases.filter(({ scenario }) => scenario.expectedError === undefined)).toHaveLength(89);
    expect(staticCount).toBe(1);
    const exports = cases
      .filter(({ scenario }) => scenario.expectedError === undefined)
      .flatMap(({ variant }) => variant.exportFormats);
    expect(exports).toHaveLength(378);
    expect(
      Object.fromEntries(
        ['glb', 'stl', 'step', '3mf', 'obj'].map((format) => [
          format,
          exports.filter((requested) => requested === format).length,
        ]),
      ),
    ).toEqual({
      glb: 89,
      stl: 80,
      step: 80,
      '3mf': 74,
      // eslint-disable-next-line id-denylist -- Wavefront OBJ is a public export format key.
      obj: 55,
    });
    expect(cases.filter(({ scenario }) => scenario.expectedComponents !== undefined)).toHaveLength(12);
    expect(
      cases.filter(({ project, scenario }) => project.id === 'stamp' && scenario.name.startsWith('component-')),
    ).toHaveLength(2);
  });
});
