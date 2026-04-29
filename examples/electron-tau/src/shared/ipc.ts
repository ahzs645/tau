/**
 * Shared IPC channel constants used by main, preload, and renderer.
 *
 * All values are plain string literal channel names. Electron's `ipcMain` /
 * `ipcRenderer` use string channel names; centralising them here keeps the
 * three processes in lockstep.
 *
 * v6 Topology C uses a single `connectRuntime` request that carries both
 * the kernel + FS over the same MessagePort (the FS is hosted inside the
 * utility process, accessed in-isolate from the kernel — no separate
 * FS-bridge port required for the PoC).
 */

export const ipcChannel = Object.freeze({
  /**
   * Renderer asks main to spawn a utility-process kernel host and ship
   * back the renderer-bound `MessagePort`. The relayed port lands on
   * the renderer via `window.postMessage` (preload bridge) under the
   * tag `${connectRuntime}:port`.
   */
  connectRuntime: 'taucad:connect-runtime',
} as const);

export type IpcChannel = (typeof ipcChannel)[keyof typeof ipcChannel];
