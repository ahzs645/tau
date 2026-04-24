// @vitest-environment node
import { existsSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Server } from 'node:http';

const buildServerEntry = resolve(import.meta.dirname, 'build/server/index.js');
const buildClientAssets = resolve(import.meta.dirname, 'build/client/assets');
const requiredHeaders = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
} as const;

function findFirstWorkerAsset(): string | undefined {
  if (!existsSync(buildClientAssets)) {
    return undefined;
  }
  const entries = readdirSync(buildClientAssets);
  return entries.find((name) => /\.worker-[^.]+\.js$/.test(name));
}

const buildExists = existsSync(buildServerEntry);
const describeIfBuilt = buildExists ? describe : describe.skip;

if (!buildExists) {
  console.warn(
    `[server.test.ts] Skipping cross-origin isolation parity tests: ${buildServerEntry} not found. ` +
      'Run `pnpm nx build ui` first to enable this regression guard.',
  );
}

const workerAsset = buildExists ? findFirstWorkerAsset() : undefined;

describeIfBuilt('apps/ui server (cross-origin isolation parity)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const { createApp } = (await import('./server.js')) as { createApp: () => Promise<Express> | Express };
    const app = await createApp();
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => {
        resolve();
      });
      server.on('error', reject);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });

  it('should serve the SSR HTML document with all three COI headers', async () => {
    const response = await fetch(baseUrl + '/');
    expect(response.status).toBeLessThan(500);
    for (const [name, value] of Object.entries(requiredHeaders)) {
      expect(response.headers.get(name), `${name} on /`).toBe(value);
    }
  });

  it.runIf(workerAsset !== undefined)('should serve worker script assets with all three COI headers', async () => {
    const response = await fetch(`${baseUrl}/assets/${workerAsset}`);
    expect(response.status).toBe(200);
    for (const [name, value] of Object.entries(requiredHeaders)) {
      expect(response.headers.get(name), `${name} on /assets/${workerAsset}`).toBe(value);
    }
  });

  it('should serve WASM static assets with all three COI headers', async () => {
    const response = await fetch(`${baseUrl}/draco_decoder_gltf.wasm`);
    expect(response.status).toBe(200);
    for (const [name, value] of Object.entries(requiredHeaders)) {
      expect(response.headers.get(name), `${name} on /draco_decoder_gltf.wasm`).toBe(value);
    }
  });
});
