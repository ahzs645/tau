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

  it('should require all 93 public cases and 383 positive export requests for the full command', async () => {
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
    ]);
    const exports = cases
      .filter(({ scenario }) => scenario.expectedError === undefined)
      .flatMap(({ variant }) => variant.exportFormats);
    expect(exports).toHaveLength(383);
    expect(
      Object.fromEntries(
        ['glb', 'stl', 'step', '3mf', 'obj'].map((format) => [
          format,
          exports.filter((requested) => requested === format).length,
        ]),
      ),
    ).toEqual({
      glb: 90,
      stl: 81,
      step: 81,
      '3mf': 75,
      // eslint-disable-next-line id-denylist -- Wavefront OBJ is a public export format key.
      obj: 56,
    });
    expect(cases.filter(({ scenario }) => scenario.expectedComponents !== undefined)).toHaveLength(12);
    expect(
      cases.filter(({ project, scenario }) => project.id === 'stamp' && scenario.name.startsWith('component-')),
    ).toHaveLength(2);
  });
});
