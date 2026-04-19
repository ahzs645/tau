import { test, expect } from '@playwright/test';

test.describe('Build Preview', () => {
  test('renders a 3D model for the Hollow Box project', async ({ page }) => {
    await page.goto('/projects/proj_hollow_box/preview');

    const canvas = page.getByRole('img', { name: /3d model preview/i });
    await expect(canvas).toBeVisible({ timeout: 45_000 });

    await expect(page.getByRole('alert')).not.toBeVisible();

    await expect(canvas).toHaveScreenshot('hollow-box-preview.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('shows loading state before model is ready', async ({ page }) => {
    await page.goto('/projects/proj_hollow_box/preview');

    const loading = page.getByRole('status', { name: /loading preview/i });
    const canvas = page.getByRole('img', { name: /3d model preview/i });

    // One of these must be visible immediately after navigation
    await expect(loading.or(canvas)).toBeVisible({ timeout: 10_000 });
  });

  test('displays an error for a non-existent project', async ({ page }) => {
    await page.goto('/projects/proj_does_not_exist/preview');

    const alert = page.getByRole('alert', { name: /preview error/i });
    await expect(alert).toBeVisible({ timeout: 45_000 });
  });
});
