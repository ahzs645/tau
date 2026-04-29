/**
 * Electron main process entry — v6 Topology C orchestration.
 *
 * Responsibilities (per docs/research/runtime-transport-architecture-v6.md):
 *
 * 1. Mount the `BrowserWindow` with COEP / COOP headers so the
 *    renderer's `crossOriginIsolated === true` precondition for
 *    `SharedArrayBuffer` is satisfied.
 * 2. On every `taucad:connect-runtime` IPC: spawn a fresh
 *    `utilityProcess.fork(kernel-host.cjs)`, allocate a
 *    `MessageChannelMain` pair, ship the utility-side port to the
 *    utility via `utility.postMessage(_, [utilityPort])`, and ship the
 *    renderer-side port to the renderer via
 *    `webContents.postMessage('taucad:runtime-port', _, [rendererPort])`.
 * 3. Bind the utility process lifecycle to the spawning `webContents`
 *    so a renderer reload / close / crash tears down the utility.
 *
 * The kernel `worker_threads.Worker` runs INSIDE the utility process,
 * never on main. Main carries no transport plugin itself — it is pure
 * orchestration glue.
 */

import { join } from 'node:path';

import { app, BrowserWindow, ipcMain, MessageChannelMain, session, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';

import { ipcChannel } from '../shared/ipc.js';

const isDevelopment = process.env['ELECTRON_RENDERER_URL'] !== undefined;
const DEBUG_ENABLED = process.env['TAU_ELECTRON_DEBUG'] === '1';

const debugLog = (message: string, data?: Record<string, unknown>): void => {
  if (!DEBUG_ENABLED) {
    return;
  }
  // eslint-disable-next-line no-console -- diagnostic seam (gated by TAU_ELECTRON_DEBUG)
  console.log(`[tau-electron:main] ${message}${data ? ` ${JSON.stringify(data)}` : ''}`);
};

/**
 * Install the Cross-Origin-Embedder-Policy + Cross-Origin-Opener-Policy
 * header pair on the default session exactly once.
 */
function installCrossOriginIsolationHeaders(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Cross-Origin-Embedder-Policy': ['require-corp'],
        'Cross-Origin-Opener-Policy': ['same-origin'],
      },
    });
  });
}

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await (isDevelopment
    ? window.loadURL(process.env['ELECTRON_RENDERER_URL']!)
    : window.loadFile(join(import.meta.dirname, '../renderer/index.html')));

  window.show();
  return window;
}

const kernelHostPath = join(import.meta.dirname, 'kernel-host.cjs');

type SpawnedRuntime = {
  readonly utility: UtilityProcess;
  readonly rendererPort: Electron.MessagePortMain;
};

/**
 * Spawn a fresh utility-process kernel host for one renderer-side
 * `connect-runtime` request. Returns the renderer-bound
 * `MessagePortMain` so main can ship it via
 * `webContents.postMessage`.
 *
 * The utility-side port is shipped to the utility via
 * `utility.postMessage(payload, [utilityPort])`; the kernel host's
 * `process.parentPort.once('message', ...)` handshake receives it.
 */
function spawnRuntimeForRenderer(): SpawnedRuntime {
  debugLog('spawning-utility', { kernelHostPath });
  const utility = utilityProcess.fork(kernelHostPath, [], {
    serviceName: 'tau-kernel-host',
    stdio: 'inherit',
    /* Forward TAU_ELECTRON_DEBUG into the utility process so its boot
     * sequence emits the same diagnostic trail. */
    env: { ...process.env },
  });
  utility.on('exit', (code) => {
    debugLog('utility-exited', { code });
  });
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- electron typings lag for utility 'spawn' event
  utility.on('spawn' as any, () => {
    debugLog('utility-spawned', { pid: utility.pid });
  });

  const { port1: rendererPort, port2: utilityPort } = new MessageChannelMain();
  debugLog('channel-pair-allocated');

  /* Ship the utility-side port to the utility process. The kernel-host
   * bootstrap awaits this on `process.parentPort.once('message', ...)`. */
  utility.postMessage({ taucadHello: true }, [utilityPort]);
  debugLog('utility-port-posted-to-utility');

  return { utility, rendererPort };
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  installCrossOriginIsolationHeaders();
  await createMainWindow();

  ipcMain.on(ipcChannel.connectRuntime, (event) => {
    debugLog('ipc-connect-runtime');
    let spawned: SpawnedRuntime;
    try {
      spawned = spawnRuntimeForRenderer();
    } catch (error) {
      console.error('[tau-electron:main] spawnRuntimeForRenderer failed', error);
      return;
    }

    /* Ship the renderer-side `MessagePortMain` to the renderer; preload
     * forwards it via `window.postMessage` so the renderer's main-world
     * receives a genuine WHATWG `MessagePort` (not a stripped clone). */
    event.senderFrame!.postMessage(`${ipcChannel.connectRuntime}:port`, undefined, [spawned.rendererPort]);
    debugLog('renderer-port-shipped-to-frame');

    event.sender.once('destroyed', () => {
      debugLog('webcontents-destroyed-killing-utility');
      try {
        spawned.utility.kill();
      } catch {
        /* Best-effort */
      }
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

void (async (): Promise<void> => {
  try {
    await bootstrap();
  } catch (error) {
    console.error('[tau-electron:main] bootstrap failed', error);
    app.exit(1);
  }
})();
