/**
 * Utility-process kernel host bootstrap (Topology C).
 *
 * Spawned by Electron main via `utilityProcess.fork(kernelHostUrl)`.
 *
 * Clean v6 wiring: `electronUtilityTransport.host()` waits on
 * `process.parentPort` for the `MessagePortMain` shipped from main,
 * instantiates a `KernelRuntimeWorker`, and runs
 * `createWorkerDispatcher` over the wire. The dispatcher dynamically
 * imports each kernel module from the `moduleUrl` shipped on the wire
 * (originating from the renderer's bundle), relying on
 * `electron.vite.config.ts`'s `tsModuleUrlPlugin` to ensure those URLs
 * point at transpiled `.js` chunks rather than raw `.ts` source.
 */

import { createRuntimeHost } from '@taucad/runtime/host';
import { electronUtilityTransport } from '../transport/electron-utility-transport.js';

const DEBUG_ENABLED = process.env['TAU_ELECTRON_DEBUG'] === '1';
const debugLog = (origin: string, message: string, data?: Record<string, unknown>): void => {
  if (!DEBUG_ENABLED) {
    return;
  }
  // eslint-disable-next-line no-console -- diagnostic seam (gated by TAU_ELECTRON_DEBUG)
  console.log(`[tau-electron:utility:${origin}] ${message}${data ? ` ${JSON.stringify(data)}` : ''}`);
};

debugLog('bootstrap', 'module-loaded', { argv: process.argv });

/* The plugin factory `host({})` builds the `RuntimeTransportHost`
 * instance; `createRuntimeHost` consumes the pre-configured handle.
 * The host awaits the `MessagePortMain` over `process.parentPort`
 * lazily on `open()` (driven by the runtime core), so this call
 * returns immediately. */
const host = createRuntimeHost({ transport: electronUtilityTransport.host({}) });
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
