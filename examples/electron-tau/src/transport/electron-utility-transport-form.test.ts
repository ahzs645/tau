/**
 * Callable {@link electronUtilityTransport} plugin shape sanity check (Topology C).
 *
 * Uses a paired {@link MessageChannel} port — avoids touching Electron internals.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import { electronUtilityClientDescribe } from './electron-utility-client.js';
import { electronUtilityTransport } from './electron-utility-transport.js';

describe('electronUtilityTransport — callable TransportPlugin surface', () => {
  it('wired plugin exposes literal id + describe parity with named client factories', () => {
    const { port1 } = new MessageChannel();
    const wired = electronUtilityTransport({ port: port1 });

    expect(wired.id).toBe('electron-utility');
    expect(wired.describe().id).toBe('electron-utility');
    expect(electronUtilityClientDescribe({ port: port1 }).id).toBe('electron-utility');
    expect(typeof wired.materialize).toBe('function');
  });

  it('callable has no synthesized `.host` / `.client` accessors', () => {
    expect(Object.hasOwn(electronUtilityTransport, 'host')).toBe(false);
    expect(Object.hasOwn(electronUtilityTransport, 'client')).toBe(false);
  });
});
