import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from 'playwright/test';
import type { Page } from 'playwright/test';
import { measureGlb } from '#scripts/measure-glb.js';
import { validateStepStructure, validateThreeMfStructure } from '#scripts/export-structure.js';
import { readNodeCatalog } from '#scripts/catalog-node.js';
import { readGalleryLocation } from '#sharing/location.js';

const waitForModel = async (page: Page): Promise<void> => {
  await expect(page.getByRole('img', { name: '3D model preview', exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByRole('region', { name: 'Interactive model viewer' })).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByLabel('Model dimensions', { exact: true })).toContainText('mm');
  await expect(page.getByRole('alert')).toHaveCount(0);
};

test('static routes, searchable catalogue and legacy model links', async ({ page, request }, testInfo) => {
  const response = await page.goto('/');
  expect(response?.headers()['cross-origin-opener-policy']).toBeUndefined();
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(false);
  await expect(page.getByRole('link', { name: /^Open /u })).toHaveCount(21);
  await page.screenshot({ path: testInfo.outputPath('gallery-desktop.png'), fullPage: true });
  await page.getByRole('searchbox', { name: 'Search gallery' }).fill('bottle separator');
  await expect(page.getByRole('link', { name: /^Open /u })).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Open Bottle Separator' })).toBeVisible();

  const metadata = await request.get('/build-meta.json');
  expect(metadata.ok()).toBe(true);
  const build: unknown = await metadata.json();
  expect(build).toMatchObject({ application: '@taucad/gallery', publicProjects: 21 });
  const cname = await request.get('/CNAME');
  const hostname = await cname.text();
  expect(hostname.trim()).toBe('3dd.ahmadjalil.com');

  await Promise.all(
    [
      { url: '/GALLERY-LICENSE.txt', text: 'Gallery component licenses' },
      { url: '/licenses/openscad/LICENSE', text: 'GNU GENERAL PUBLIC LICENSE' },
      { url: '/licenses/openscad/NOTICE.md', text: 'openscad-wasm-prebuilt@1.2.0' },
      { url: '/licenses/openscad/ENGINE-COPYING.txt', text: 'GNU GENERAL PUBLIC LICENSE' },
      { url: '/licenses/openscad/fonts/OFL.txt', text: 'SIL OPEN FONT LICENSE Version 1.1' },
    ].map(async ({ url, text }) => {
      const notice = await request.get(url);
      expect(notice.ok(), url).toBe(true);
      const contents = await notice.text();
      expect(contents, url).toContain(text);
      expect(contents, url).not.toMatch(/<!doctype\s+html|<html(?:\s|>)/iu);
    }),
  );

  // Inspect the bytes fetched by the real worker, including the production asset URL rewrite.
  const fonts = [
    {
      path: /\/Geist-Regular-[^/]+\.ttf$/u,
      sha256: '8177983fd81e22d440b343d931c508aa87eeb7a43907223b648e4c66214a3999',
    },
    {
      path: /\/Geist-Bold-[^/]+\.ttf$/u,
      sha256: '45e6b30280949f1aa0208a4b05f47e1984719aba0b7fcc2bc993a15b9199f644',
    },
  ];
  await Promise.all([
    ...fonts.map(async (font) => {
      const asset = await page.waitForResponse((item) => font.path.test(new URL(item.url()).pathname), {
        timeout: 120_000,
      });
      expect(asset.ok(), asset.url()).toBe(true);
      expect(
        createHash('sha256')
          .update(await asset.body())
          .digest('hex'),
        asset.url(),
      ).toBe(font.sha256);
    }),
    page.goto('/tau/playground/?model=openscad-bracket'),
  ]);
  await expect(page.getByRole('heading', { level: 1, name: 'OpenSCAD bracket' })).toBeVisible();
  await waitForModel(page);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Share link' })).toHaveValue(/\/openscad-bracket\?p=1\.raw\./u);
});

test('SCAD renders changed parameters and downloads the committed geometry', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const postRadiusParameter = 'post_radius';
  const holeRadiusParameter = 'hole_radius';
  const payload = Buffer.from(
    JSON.stringify({ plate: [100, 38, 6], [postRadiusParameter]: 8, [holeRadiusParameter]: 3.2 }),
  ).toString('base64url');
  await page.goto(`/openscad-bracket/?p=1.raw.${payload}`);
  await waitForModel(page);
  await expect(page.getByRole('navigation', { name: 'Model panels' })).toBeHidden();
  await expect(page.getByLabel('Model dimensions', { exact: true })).toContainText('100');
  await page.getByRole('combobox', { name: 'Export format' }).selectOption('glb');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.glb$/u);
  const filename = await download.path();
  expect(filename).not.toBeNull();
  if (!filename) {
    throw new Error('The browser did not write the model download.');
  }
  const bytes = await readFile(filename);
  expect(bytes.subarray(0, 4).toString()).toBe('glTF');
  expect(bytes.readUInt32LE(8)).toBe(bytes.length);
  const geometry = await measureGlb(new Uint8Array(bytes));
  expect(geometry.boundsMm.size[0]).toBeCloseTo(100, 2);
  await page.screenshot({ path: testInfo.outputPath('model-desktop.png'), fullPage: true });

  await page.getByRole('button', { name: 'Reset parameters' }).click();
  await waitForModel(page);
  await expect(page.getByLabel('Model dimensions', { exact: true })).toContainText('70');
  expect(errors).toEqual([]);
});

for (const model of [
  { id: 'opencascade-box', title: 'OpenCascade direct' },
  { id: 'replicad-tray', title: 'Replicad tray' },
]) {
  test(`${model.title} preserves authored parameters and STEP export`, async ({ page }) => {
    await page.goto(`/${model.id}/`);
    await expect(page.getByRole('heading', { level: 1, name: model.title, exact: true })).toBeVisible();
    await waitForModel(page);
    await expect(page.getByRole('complementary', { name: 'Model parameters' })).not.toContainText(
      'no additional editable parameters',
    );
    await page.getByRole('combobox', { name: 'Export format' }).selectOption('step');
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toMatch(/\.(?:step|stp)$/u);
    const filename = await download.path();
    if (!filename) {
      throw new Error(`No STEP download was written for ${model.id}.`);
    }
    const contents = await readFile(filename, 'utf8');
    expect(contents.trimStart()).toMatch(/^ISO-10303-21;/u);
  });
}

test('mobile layout keeps the viewer and parameter controls usable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/openscad-bracket/');
  await waitForModel(page);
  await expect(page.getByRole('navigation', { name: 'Model panels' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Interactive model viewer' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('model-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Parameters', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Model parameters' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset parameters' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('parameters-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '3D view', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Interactive model viewer' })).toBeVisible();
});

test('a failing saved keyguard link stays editable and recovers without exporting a stale preview', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const catalogue = await readNodeCatalog();
  const project = catalogue.find((entry) => entry.project.id === 'keyguard-with-raised-tabs')?.project;
  const preset = project?.presets.find(({ id }) => id === 'preset-2');
  if (!project || !preset) {
    throw new Error('Missing the preserved keyguard frame preset.');
  }
  const frameParameter = 'have_a_keyguard_frame';
  expect(preset.parameters['generate']).toBe('keyguard frame');
  expect(preset.parameters[frameParameter]).toBe('no');
  const payload = Buffer.from(JSON.stringify(preset.parameters)).toString('base64url');
  await page.goto(`/${project.id}/?p=1.raw.${payload}`);
  const actionableError =
    'Keyguard frame output requires Have a case and Have a keyguard frame set to yes. Enable both, or choose keyguard output.';
  const alert = page.getByRole('alert');
  await expect(alert).toContainText(actionableError, { timeout: 120_000 });
  await alert.getByText('Error details', { exact: true }).click();
  await expect(alert.getByText(/Keyguard frame output requires/u)).toBeVisible();
  const downloadButton = page.getByRole('button', { name: 'Export', exact: true });
  await expect(downloadButton).toBeDisabled();
  const panel = page.getByRole('complementary', { name: 'Model parameters' });
  await expect(panel.getByRole('status', { name: 'Loading model parameters' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Reset parameters' })).toBeEnabled();
  // Search mounts the matching group in this large virtualized form; authored field titles keep underscores.
  await panel.getByRole('searchbox', { name: 'Filter parameters…', exact: true }).fill(frameParameter);
  const frame = panel.getByRole('combobox', { name: `Select for ${frameParameter}`, exact: true });
  await expect(frame).toHaveText('no');
  await frame.click();
  await page.getByRole('option', { name: 'yes', exact: true }).click();
  await waitForModel(page);
  await expect(frame).toHaveText('yes');
  const corrected = readGalleryLocation(new URL(page.url())).parameters;
  expect(corrected).not.toHaveProperty(frameParameter);
  expect(corrected['Keyguard Frame Info']).toMatchObject({ [frameParameter]: 'yes' });
  expect(corrected['Keyguard Basics']).toMatchObject({ generate: 'keyguard frame' });

  await page.getByRole('combobox', { name: 'Export format' }).selectOption('glb');
  const pending = page.waitForEvent('download');
  await downloadButton.click();
  const download = await pending;
  const filename = await download.path();
  if (!filename) {
    throw new Error('No corrected keyguard GLB download was written.');
  }
  const geometry = await measureGlb(new Uint8Array(await readFile(filename)));
  expect(geometry.triangles).toBeGreaterThan(0);
  expect(geometry.surfaceAreaMm2).toBeGreaterThan(0);

  const dimensions = await page.getByLabel('Model dimensions', { exact: true }).textContent();
  await panel.getByRole('combobox', { name: 'Preset', exact: true }).selectOption('preset-2');
  await expect(downloadButton).toBeDisabled();
  await expect(alert).toContainText(actionableError, { timeout: 120_000 });
  await expect(alert).toContainText('The last successful preview is still visible.');
  await expect(page.getByRole('img', { name: '3D model preview', exact: true })).toBeVisible();
  await expect(page.getByLabel('Model dimensions', { exact: true })).toHaveText(dimensions ?? '');
  await expect(downloadButton).toBeDisabled();
  await panel.getByRole('button', { name: 'Reset parameters' }).click();
  await waitForModel(page);
  await expect(frame).toHaveText('no');
  expect(readGalleryLocation(new URL(page.url())).parameters).toEqual(project.initialParameters);
});

test('stamp artwork and the handle selector change the real exported geometry', async ({ page }) => {
  test.setTimeout(300_000);
  const exportGeometry = async () => {
    await page.getByRole('combobox', { name: 'Export format' }).selectOption('glb');
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await pending;
    const filename = await download.path();
    if (!filename) {
      throw new Error('No stamp GLB download was written.');
    }
    return measureGlb(new Uint8Array(await readFile(filename)));
  };
  await page.goto('/stamp/');
  await waitForModel(page);
  const original = await exportGeometry();
  await page.getByLabel('Artwork (SVG)', { exact: true }).setInputFiles({
    name: 'test-artwork.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80"/></svg>',
    ),
  });
  await expect(page.getByText('test-artwork.svg', { exact: true })).toBeVisible();
  await waitForModel(page);
  const uploaded = await exportGeometry();
  expect(Math.abs(original.signedVolumeMm3 - uploaded.signedVolumeMm3)).toBeGreaterThan(1);

  const component = page.getByRole('combobox', { name: 'Component', exact: true });
  await expect(component).toHaveCount(1);
  await expect(page.getByRole('combobox', { name: /Select for Component/iu })).toHaveCount(0);
  await component.selectOption('handle');
  await waitForModel(page);
  await expect(component).toHaveValue('handle');
  const handle = await exportGeometry();
  // The preserved handle STL is Z-up 20 × 23.094 × 50 mm; GLB downloads use canonical Y-up metres.
  expect(handle.boundsMm.size[0]).toBeCloseTo(20, 2);
  expect(handle.boundsMm.size[1]).toBeCloseTo(50, 2);
  expect(handle.boundsMm.size[2]).toBeCloseTo(23.094, 2);
  // The viewer maps canonical GLB into Tau's Z-up world before reporting physical bounds for the label.
  await expect(page.getByLabel('Model dimensions', { exact: true })).toHaveText('X 20 · Y 23.09 · Z 50 mm');

  // These formats use the browser Assimp worker; STEP is a faceted conversion of the authored SCAD mesh.
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(false);
  const formatControl = page.getByRole('combobox', { name: 'Export format' });
  const exportConverted = async (format: '3mf' | 'step', label: string): Promise<Uint8Array<ArrayBuffer>> => {
    await expect(formatControl.getByRole('option', { name: label, exact: true })).toHaveAttribute('value', format);
    await formatControl.selectOption({ label });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      page.getByRole('button', { name: 'Export', exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(format === '3mf' ? /\.3mf$/u : /\.(?:step|stp)$/u);
    const filename = await download.path();
    if (!filename) {
      throw new Error(`No stamp ${format.toUpperCase()} download was written.`);
    }
    await expect(page.getByRole('alert')).toHaveCount(0);
    return new Uint8Array(await readFile(filename));
  };
  const threeMf = await exportConverted('3mf', '3MF');
  expect(validateThreeMfStructure(threeMf)['triangles']).toBeGreaterThan(0);
  const step = await exportConverted('step', 'STEP (faceted)');
  expect(validateStepStructure(step)['surfaces']).toBeGreaterThan(0);

  const parametersPanel = page.getByRole('complementary', { name: 'Model parameters' });
  const attribution = parametersPanel.getByRole('link', { name: 'Project source and attribution' });
  await attribution.scrollIntoViewIfNeeded();
  await expect(attribution).toBeInViewport();
  const formBounds = await parametersPanel.locator('[data-slot="parameters"]').boundingBox();
  const attributionBounds = await attribution.boundingBox();
  if (!formBounds || !attributionBounds) {
    throw new Error('The stamp parameter form and attribution must remain visible in the parameter pane.');
  }
  expect(formBounds.y + formBounds.height).toBeLessThanOrEqual(attributionBounds.y);

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Uploaded files stay in this browser');
});

test('PET lower-module controls retain edits and honor presets', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/pet-bottle-opener/');
  await waitForModel(page);
  const panel = page.getByRole('complementary', { name: 'Model parameters' });
  await expect(panel.getByText('Handle hole Ø (mm)', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('Module spacing (mm)', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('Neck width (mm)', { exact: true })).toHaveCount(0);
  const module = panel.getByRole('combobox', { name: 'Select for Module', exact: true });
  await expect(module).toHaveText('None');
  await page.getByRole('combobox', { name: 'Preset', exact: true }).selectOption({ label: 'Thin handle' });
  await waitForModel(page);
  await expect(panel.getByText('Handle hole Ø (mm)', { exact: true })).toBeVisible();
  await expect(panel.getByText('Handle radius (mm)', { exact: true })).toBeVisible();
  await expect(panel.getByText('Module spacing (mm)', { exact: true })).toBeVisible();
  await expect(panel.getByText('Neck width (mm)', { exact: true })).toBeVisible();
  await expect(panel.getByText('Second opener size', { exact: true })).toHaveCount(0);
  const hole = panel.getByRole('spinbutton', { name: 'Input for Handle hole Ø (mm)', exact: true });
  await expect(hole).toHaveValue('25');
  await hole.fill('27');
  await hole.press('Enter');
  await expect(hole).toHaveValue('27');
  await waitForModel(page);
  await module.click();
  await page.getByRole('option', { name: 'None', exact: true }).click();
  await expect(panel.getByText('Handle hole Ø (mm)', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('Neck width (mm)', { exact: true })).toHaveCount(0);
  await module.click();
  await page.getByRole('option', { name: 'Handle', exact: true }).click();
  await expect(hole).toHaveValue('27');
  await waitForModel(page);
  await page.getByRole('combobox', { name: 'Preset', exact: true }).selectOption({ label: 'Dual opener (smaller)' });
  await waitForModel(page);
  await expect(panel.getByText('Second opener size', { exact: true })).toBeVisible();
  await expect(panel.getByText('Second cap diameter (mm)', { exact: true })).toBeVisible();
  await expect(panel.getByRole('spinbutton', { name: 'Input for Second cap diameter (mm)', exact: true })).toHaveValue(
    '19',
  );
  await expect(panel.getByText('Module spacing (mm)', { exact: true })).toBeVisible();
  await expect(panel.getByText('Neck width (mm)', { exact: true })).toBeVisible();
  await expect(panel.getByText('Handle hole Ø (mm)', { exact: true })).toHaveCount(0);
});
