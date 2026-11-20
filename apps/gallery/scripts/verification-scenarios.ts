import type { GalleryProject, GalleryVariant } from '#catalog/types.js';

export type VerificationScenario = {
  name: string;
  parameters?: Record<string, unknown>;
  expectedSizeMm?: readonly [number, number, number];
  expectedWidthMm?: number;
  expectedError?: string;
  expectedComponents?: number;
  bedSizeMm?: readonly [number, number];
};

/** Preserve UI preset replacement semantics and keep specialized physical assertions on their authored variants. */
export const verificationScenarios = (
  project: GalleryProject,
  variant: GalleryVariant,
  withRegressions: boolean,
): VerificationScenario[] => {
  const scenarios: VerificationScenario[] = [{ name: 'defaults' }];
  if (withRegressions && project.components?.variantIds.includes(variant.id)) {
    const { parameter, options } = project.components;
    scenarios.push(
      ...options.map(
        (option): VerificationScenario => ({
          name: `component-${option.value}`,
          parameters: { [parameter]: option.value },
          // Measured from the preserved binary handle template; this branch imports it without scaling.
          ...(project.id === 'stamp' && option.value === 'handle'
            ? { expectedSizeMm: [20, 50, 23.094011306762695] as const }
            : {}),
        }),
      ),
    );
  }
  if (withRegressions && variant.id === project.defaultVariantId && project.id !== 'bottle-separator') {
    scenarios.push(
      ...project.presets.map((preset) => ({
        name: preset.id,
        parameters: preset.parameters,
        // The original engine confirms this preserved frame-disabled preset produces an empty result; see its SOURCE.md.
        ...(project.id === 'keyguard-with-raised-tabs' && preset.id === 'preset-2'
          ? {
              expectedError:
                'Keyguard frame output requires Have a case and Have a keyguard frame set to yes. Enable both, or choose keyguard output.',
            }
          : {}),
      })),
    );
  }
  if (!withRegressions || project.id !== 'bottle-separator' || variant.id !== 'openscad') {
    return scenarios;
  }
  /* eslint-disable @typescript-eslint/naming-convention -- Bottle regression overrides retain the source model's exact OpenSCAD parameter keys. */
  for (const fit of [
    { parameters: {}, widths: [300.6, 400, 400, 101.8] },
    { parameters: { bottle_diameter: 80, side_clearance: 1.5, bottle_gap: 6 }, widths: [261, 347, 347, 89] },
  ]) {
    for (const [index, preset] of project.presets.entries()) {
      scenarios.push({
        name: `${preset.id}-${Object.keys(fit.parameters).length === 0 ? 'standard' : '80mm'}`,
        parameters: { ...preset.parameters, 'Bottle fit': fit.parameters },
        expectedWidthMm: fit.widths[index],
        expectedComponents: 1,
      });
    }
  }
  scenarios.push(
    {
      name: 'single-hex-cell',
      parameters: { output_part: 'Print one cell', bed_width: 180, bed_depth: 180 },
      expectedSizeMm: [103, 65, 115.05],
      expectedComponents: 1,
      bedSizeMm: [180, 180],
    },
    {
      name: 'rotated-small-bed-cell',
      parameters: { output_part: 'Print one cell', bed_width: 120, bed_depth: 105 },
      expectedSizeMm: [115.05, 65, 103],
      expectedComponents: 1,
      bedSizeMm: [120, 105],
    },
    {
      name: 'inline-cell',
      parameters: { layout: 'Inline', output_part: 'Print one cell', bed_width: 110, bed_depth: 110 },
      expectedSizeMm: [103, 65, 103],
      expectedComponents: 1,
      bedSizeMm: [110, 110],
    },
    {
      name: 'dovetail-fit-pair',
      parameters: { output_part: 'Joint test pair', bed_width: 100, bed_depth: 100 },
      expectedSizeMm: [5.05, 12, 22.8],
      expectedComponents: 2,
      bedSizeMm: [100, 100],
    },
    {
      name: 'invalid-bottle-gap',
      parameters: { bottle_gap: 2, side_clearance: 1.5 },
      expectedError: 'Bottle gap must be at least 4',
    },
    {
      name: 'bed-too-small',
      parameters: { output_part: 'Print one cell', bed_width: 100 },
      expectedError: 'Usable bed',
    },
  );
  /* eslint-enable @typescript-eslint/naming-convention -- Restore naming checks after the authored OpenSCAD override payloads. */
  return scenarios;
};
