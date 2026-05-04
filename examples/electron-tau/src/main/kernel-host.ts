/**
 * Utility-process kernel host bootstrap (Topology C).
 *
 * Spawned by Electron main via `utilityProcess.fork(kernelHostUrl)`.
 *
 * `electronUtilityHost({ fileSystem })` waits on
 * `process.parentPort` for the `MessagePortMain` shipped from main,
 * instantiates a `KernelRuntimeWorker`, and runs
 * `createWorkerDispatcher` over the wire. The dispatcher dynamically
 * imports each kernel module from the `moduleUrl` shipped on the wire
 * (originating from the renderer's bundle), relying on
 * `electron.vite.config.ts`'s `tsModuleUrlPlugin` to ensure those URLs
 * point at transpiled `.js` chunks rather than raw `.ts` source.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { fromNodeFs } from '@taucad/runtime/filesystem/node';
import { createRuntimeHost } from '@taucad/runtime/host';

import { electronUtilityHost } from '../transport/electron-utility-host.js';

const DEBUG_ENABLED = process.env['TAU_ELECTRON_DEBUG'] === '1';
const debugLog = (origin: string, message: string, data?: Record<string, unknown>): void => {
  if (!DEBUG_ENABLED) {
    return;
  }

  console.log(`[tau-electron:utility:${origin}] ${message}${data ? ` ${JSON.stringify(data)}` : ''}`);
};

debugLog('bootstrap', 'module-loaded', { argv: process.argv });

const projectRoot = process.env['TAU_PROJECT_ROOT'] ?? join(process.cwd(), '.tau-project');
mkdirSync(projectRoot, { recursive: true });

/* The plugin factory `host({ fileSystem })` builds the `RuntimeTransportHost`
 * instance; `createRuntimeHost` consumes the pre-configured handle and
 * eagerly invokes `transport.open()`, which awaits the
 * `MessagePortMain` arriving on `process.parentPort`.
 *
 * Eager open is safe here because the main + utility build pipeline is
 * pure ESM (`format: 'es'` in `electron.vite.config.ts`): each entry
 * compiles to an independent ES module, with shared code lifted into
 * dedicated chunk files instead of being embedded inside another entry.
 * Consequently this module body executes only when the Electron main
 * process forks the utility via `utilityProcess.fork('kernel-host.js')`
 * — never as a transitive side-effect import from the main entry. If
 * the build is ever switched back to CJS multi-entry output, Rollup
 * will re-introduce a cross-entry side-effect `require()` and this
 * eager `open()` will fail in the main process with
 * "process.parentPort unavailable". */
const host = createRuntimeHost({
  transport: electronUtilityHost({
    fileSystem: fromNodeFs(projectRoot),
  }),
});
debugLog('bootstrap', 'host-created', { hostId: host.id });

const teardown = (reason: string): void => {
  debugLog('bootstrap', 'teardown', { reason });
  try {
    host.dispose();
  } catch {
    /* Best-effort */
  }
};

process.on('exit', () => {
  teardown('exit');
});
process.on('SIGTERM', () => {
  teardown('sigterm');
  process.exit(0);
});
