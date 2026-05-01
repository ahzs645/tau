/**
 * Runtime guard for the v5 {@link RuntimeProtocol} message inventory
 * (R20). The two arrays exported alongside the protocol type are the
 * single source of truth for the inventory at runtime — every consumer
 * (dispatcher, worker client, conformance harness, docs generators)
 * enumerates them rather than re-listing the names locally.
 *
 * The matching type-level guards live in
 * {@link ./runtime-protocol.test-d.ts}. Both files together fail closed
 * if any name is added/removed without updating both surfaces.
 */
import { describe, it, expect } from 'vitest';
import type { RpcProtocol } from '@taucad/rpc';
import {
  RUNTIME_PROTOCOL_CALL_NAMES,
  RUNTIME_PROTOCOL_CLIENT_NOTIFY_NAMES,
  RUNTIME_PROTOCOL_WORKER_NOTIFY_NAMES,
  RUNTIME_PROTOCOL_NOTIFY_NAMES,
} from '#types/runtime-protocol.types.js';
import type { RuntimeProtocol } from '#types/runtime-protocol.types.js';

describe('RuntimeProtocol — runtime inventory guard (R20)', () => {
  it('exposes exactly two calls — initialize + export (R18)', () => {
    expect([...RUNTIME_PROTOCOL_CALL_NAMES]).toEqual(['initialize', 'export']);
  });

  it('exposes exactly 8 client → worker notify commands', () => {
    expect([...RUNTIME_PROTOCOL_CLIENT_NOTIFY_NAMES]).toEqual([
      'openFile',
      'stage-and-render',
      'updateParameters',
      'setOptions',
      'fileChanged',
      'configureMiddleware',
      'cleanup',
      'abort',
    ]);
  });

  it('exposes exactly 10 worker → client autonomous event notifies', () => {
    expect([...RUNTIME_PROTOCOL_WORKER_NOTIFY_NAMES]).toEqual([
      'parametersResolved',
      'geometryComputed',
      'errorEvent',
      'progress',
      'activeKernelChanged',
      'stateChanged',
      'log',
      'logBatch',
      'telemetry',
      'capabilitiesUpdated',
    ]);
  });

  it('exposes exactly 18 notify keys (8 client commands + 10 worker events)', () => {
    expect(RUNTIME_PROTOCOL_NOTIFY_NAMES).toHaveLength(18);
    expect(RUNTIME_PROTOCOL_NOTIFY_NAMES).toHaveLength(
      RUNTIME_PROTOCOL_CLIENT_NOTIFY_NAMES.length + RUNTIME_PROTOCOL_WORKER_NOTIFY_NAMES.length,
    );
  });

  it('contains no duplicate notify names', () => {
    expect(new Set(RUNTIME_PROTOCOL_NOTIFY_NAMES).size).toBe(RUNTIME_PROTOCOL_NOTIFY_NAMES.length);
  });

  it('compiles RuntimeProtocol against RpcProtocol (any drift fails compile)', () => {
    type _Guard = RuntimeProtocol extends RpcProtocol ? true : false;
    const guard: _Guard = true;
    expect(guard).toBe(true);
  });
});
