/**
 * Structural cycle-prevention regression for the node-worker transport split.
 *
 * Per `docs/research/runtime-transport-authoring-simplification.md` (R2),
 * the node-worker transport mirrors the R1 web-worker structural split:
 *
 *   - `node-worker-host.ts`     ← host() factory only; NO `new URL` literals
 *   - `node-worker-client.ts`   ← client() factory + `defaultNodeWorkerUrl`
 *   - `node-worker-transport.ts`← thin composition via `defineRuntimeTransport`
 *   - `worker/node.ts`          ← bundled worker entry; static-imports the host only
 *
 * If any of these structural invariants regresses, Rolldown's `emitFile()`
 * deadlocks during `pnpm nx build` for any consumer that bundles the Node
 * subpath (CLI, server apps, Electron utility processes). This test pins the
 * file shapes so the regression cannot land silently.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerEntryPath = path.resolve(here, '../worker/node.ts');
const hostPath = path.resolve(here, 'node-worker-host.ts');
const clientPath = path.resolve(here, 'node-worker-client.ts');
const compositionPath = path.resolve(here, 'node-worker-transport.ts');

const read = (filePath: string): string => readFileSync(filePath, 'utf8');

/**
 * Strip block + line comments before matching. The structural contract
 * targets *code*, not prose — JSDoc examples are allowed to mention
 * `new URL(...)` literals when describing the chunk-emit pattern.
 */
const stripComments = (source: string): string =>
  source.replaceAll(/\/\*[\S\s]*?\*\//g, '').replaceAll(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('node-worker transport split — cycle prevention (R2)', () => {
  it('`node-worker-host.ts` exports `nodeWorkerHost` and contains NO `new URL(` literals in code', () => {
    const source = stripComments(read(hostPath));
    expect(source).toMatch(/export const nodeWorkerHost\b/);
    expect(source).not.toMatch(/new URL\(/);
  });

  it('`node-worker-host.ts` does NOT import from the client file (severs cycle)', () => {
    const source = stripComments(read(hostPath));
    expect(source).not.toMatch(/from ["']#transport\/node-worker-client/);
  });

  it('`node-worker-client.ts` exports `nodeWorkerClient` and owns the `new URL(../worker/node.js, import.meta.url)` chunk-emit literal', () => {
    const source = read(clientPath);
    expect(source).toMatch(/export const nodeWorkerClient\b/);
    expect(source).toMatch(/new URL\(\s*["']\.\.\/worker\/node\.js["']\s*,\s*import\.meta\.url\s*\)/);
  });

  it('`node-worker-transport.ts` composes via `defineRuntimeTransport` and does NOT redeclare `client`/`host` bodies', () => {
    const source = read(compositionPath);
    expect(source).toMatch(/defineRuntimeTransport\(/);
    expect(source).toMatch(/client:\s*nodeWorkerClient/);
    expect(source).toMatch(/host:\s*nodeWorkerHost/);
    /* Composition file must not own a `new URL(` literal in code (chunk-emitter belongs in client only). */
    const stripped = stripComments(source);
    expect(stripped).not.toMatch(/new URL\(\s*["'][^"']*["']\s*,\s*import\.meta\.url/);
  });

  it('`worker/node.ts` STATIC-imports `nodeWorkerHost` and never reaches the transport composition or the client', () => {
    const source = stripComments(read(workerEntryPath));
    expect(source).toMatch(/import\s+{[^}]*\bnodeWorkerHost\b[^}]*}\s+from\s+["']#transport\/node-worker-host/);
    /* No dynamic-import workaround — the structural split makes static safe. */
    expect(source).not.toMatch(/await\s+import\(\s*["']#transport\/node-worker-(client|transport)/);
    /* No static path back to the composition or the client file either. */
    expect(source).not.toMatch(/from\s+["']#transport\/node-worker-(client|transport)/);
  });
});
