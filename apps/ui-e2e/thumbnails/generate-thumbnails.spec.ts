import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

/**
 * Poster generator for the root playground gallery.
 *
 * For every project under `apps/ui/app/routes/playground/projects/` this drives
 * the real playground (`/playground?model=<id>&editor=off`), waits for the
 * kernel render to complete, screenshots the 3D canvas, saves it as
 * `poster.jpg` in the project folder, and stamps `"image": "poster.jpg"` into
 * `project.json` so the gallery cards pick it up.
 *
 * Projects that already declare an `image` are skipped unless
 * `THUMBNAILS_FORCE=1`. Run via `nx run ui-e2e:thumbnails`.
 */

type ProjectMetadata = {
  title?: string;
  type?: string;
  hidden?: boolean;
  image?: string;
  [key: string]: unknown;
};

const projectsDirectory = fileURLToPath(new URL('../../ui/app/routes/playground/projects/', import.meta.url));
const force = process.env['THUMBNAILS_FORCE'] === '1';
/**
 * Kernel + first render can be slow (WASM boot, BOSL2 includes) — much slower
 * still on CPU-only machines. Milliseconds; override with THUMBNAILS_RENDER_TIMEOUT.
 */
const renderTimeout = Number(process.env['THUMBNAILS_RENDER_TIMEOUT'] ?? 300_000);
/** Frames need a beat to paint after the machine reports ready. Milliseconds. */
const settleDelay = 3000;

function listProjects(): Array<{ id: string; metadata: ProjectMetadata; metadataPath: string }> {
  return readdirSync(projectsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const metadataPath = join(projectsDirectory, entry.name, 'project.json');
      if (!existsSync(metadataPath)) {
        return [];
      }

      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as ProjectMetadata;
      return [{ id: entry.name, metadata, metadataPath }];
    });
}

for (const { id, metadata, metadataPath } of listProjects()) {
  test(`poster: ${id}`, async ({ page }) => {
    test.setTimeout(renderTimeout + 60_000);
    test.skip(metadata.hidden === true, 'hidden project');
    test.skip(Boolean(metadata.image) && !force, 'already has a poster (THUMBNAILS_FORCE=1 to regenerate)');

    await page.goto(`/playground?model=${encodeURIComponent(id)}&editor=off`);

    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible({ timeout: renderTimeout });

    if (metadata.type === 'static') {
      // Static projects have no export controls; give the GLB fetch + parse a beat.
      await page.waitForLoadState('networkidle', { timeout: renderTimeout });
    } else {
      // The export button only enables once the kernel reports ready geometry.
      const exportButton = page.getByRole('button', { name: /Export/ }).first();
      await expect(exportButton).toBeEnabled({ timeout: renderTimeout });
    }

    await page.waitForTimeout(settleDelay);

    const posterPath = join(projectsDirectory, id, 'poster.jpg');
    await canvas.screenshot({
      path: posterPath,
      type: 'jpeg',
      quality: 82,
      animations: 'disabled',
    });

    const nextMetadata = { ...metadata, image: 'poster.jpg' };
    writeFileSync(metadataPath, `${JSON.stringify(nextMetadata, undefined, 2)}\n`);
  });
}
