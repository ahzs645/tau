/**
 * Preload script — runs in an isolated context inside the renderer
 * with privileged access to Node IPC. Exposes a minimal `taucad`
 * bridge (Topology C):
 *
 *   - `requestRuntimePort()` triggers the main process to spawn a
 *     utility-process kernel host and ship back the renderer-side
 *     `MessagePort` for the runtime channel.
 *
 * Port-relay rationale: a `MessagePort` returned through
 * `contextBridge`-exposed functions is run through Electron's
 * "world-safe object cloning", which strips its prototype methods
 * (`addEventListener`, `start`, `close`). The only mechanism that
 * delivers a genuine WHATWG `MessagePort` to the main world is
 * `window.postMessage(payload, '*', [port])` — the renderer's main
 * world receives the port via `event.ports[0]` with all prototype
 * methods intact. Port reception is therefore performed in the
 * renderer (`app.tsx`); preload only relays.
 *
 * @see https://www.electronjs.org/docs/latest/tutorial/message-ports#main-process-to-renderer-process
 */

import { contextBridge, ipcRenderer } from 'electron';

import { ipcChannel } from '../shared/ipc.js';

const runtimeRelayTag = `${ipcChannel.connectRuntime}:port`;

ipcRenderer.on(runtimeRelayTag, (event) => {
  if (event.ports.length === 0) {
    return;
  }
  /* `window.postMessage` from preload dispatches a `'message'` event
   * on the shared window; the renderer's main-world listener receives
   * the genuine `MessagePort` via `event.ports`. Returning the port
   * from a contextBridge-exposed function would instead trip the
   * world-safe cloner and strip its methods. */
  window.postMessage({ taucadRelay: runtimeRelayTag }, '*', event.ports as unknown as Transferable[]);
});

contextBridge.exposeInMainWorld('taucad', {
  requestRuntimePort: (): void => {
    ipcRenderer.send(ipcChannel.connectRuntime);
  },
  /* Relay tag exposed so the renderer's `window.addEventListener('message',
   * …)` filter matches the same channel string the preload uses. */
  relayTag: Object.freeze({
    runtime: runtimeRelayTag,
  }),
});
