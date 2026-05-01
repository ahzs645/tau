import { test, _electron as electron } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const filename = fileURLToPath(import.meta.url);
const APP_ROOT = resolve(dirname(filename), '..');
const MAIN_ENTRY = resolve(APP_ROOT, 'dist/main/index.js');

test('probe', async () => {
  test.setTimeout(80_000);
  const log: string[] = [];
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    cwd: APP_ROOT,
    env: { ...process.env, TAU_ELECTRON_DEBUG: '1' },
    timeout: 60_000,
  });
  const proc = app.process();
  proc.stderr?.on('data', (c: Uint8Array<ArrayBuffer>) => log.push(`[stderr] ${c.toString()}`));
  proc.stdout?.on('data', (c: Uint8Array<ArrayBuffer>) => log.push(`[stdout] ${c.toString()}`));
  log.push(`[host] launched, pid=${proc.pid}\n`);
  try {
    const win = await Promise.race([
      app.firstWindow().then((w) => ({ ok: true as const, win: w })),
      new Promise<{ ok: false }>((r) => setTimeout(() => r({ ok: false }), 8_000)),
    ]);
    log.push(`[host] firstWindow result ok=${win.ok}\n`);
    if (win.ok) {
      win.win.on('console', (m) => log.push(`[renderer:${m.type()}] ${m.text()}\n`));
      win.win.on('pageerror', (e) => log.push(`[renderer:err] ${e.message}\n${e.stack}\n`));
      try {
        const url = win.win.url();
        log.push(`[host] url=${url}\n`);
        await win.win
          .waitForLoadState('domcontentloaded', { timeout: 5_000 })
          .catch((e) => log.push(`[host] domcontent err ${e}\n`));
        const html = await win.win.content().catch((e) => `<err: ${e}>`);
        log.push(`[host] html-len=${html.length}\n`);
        log.push(`[host] html-head=${html.slice(0, 500)}\n`);
      } catch (e) {
        log.push(`[host] window probe error ${e}\n`);
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
  } finally {
    writeFileSync('/tmp/tau-probe.log', log.join(''));
    await app.close().catch(() => {});
  }
});
