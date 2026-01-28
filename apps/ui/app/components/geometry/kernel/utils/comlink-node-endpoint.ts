/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Endpoint } from 'comlink';

export type NodeEndpoint = {
  start?: () => void;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  on(type: string, listener: EventListenerOrEventListenerObject, options?: unknown): void;
  off(type: string, listener: EventListenerOrEventListenerObject, options?: unknown): void;
};

export default function nodeEndpoint(nep: NodeEndpoint): Endpoint {
  const listeners = new WeakMap<EventListenerOrEventListenerObject, (data: unknown) => void>();
  return {
    postMessage: nep.postMessage.bind(nep),
    addEventListener(_, eh) {
      const l = (data: unknown) => {
        if ('handleEvent' in eh) {
          eh.handleEvent({ data } as MessageEvent);
        } else {
          eh({ data } as MessageEvent);
        }
      };

      nep.on('message', l);
      listeners.set(eh, l);
    },
    removeEventListener(_, eh) {
      const l = listeners.get(eh);
      if (!l) {
        return;
      }

      nep.off('message', l);
      listeners.delete(eh);
    },
    start: nep.start?.bind(nep),
  };
}
