/**
 * Conformance test C15: every entry in `RuntimeProtocol['calls']` and
 * `RuntimeProtocol['notifies']` has a matching Zod schema in
 * `runtimeProtocolSchemas`. New protocol entries fail this test until
 * they ship a validator.
 *
 * Catches the failure mode where a developer adds a new call/notify to
 * the protocol but forgets to add its wire-validation schema — which
 * would silently disable validation for that frame on every wire that
 * opted in to `protocolSchemas`.
 */

import { describe, it, expect } from 'vitest';
import { RUNTIME_PROTOCOL_CALL_NAMES, RUNTIME_PROTOCOL_NOTIFY_NAMES } from '#types/runtime-protocol.types.js';
import { runtimeProtocolSchemas } from '#types/runtime-protocol.schemas.js';

describe('runtime-protocol schema coverage (C15)', () => {
  it('every protocol call has a matching schema entry', () => {
    const callSchemaNames = new Set(Object.keys(runtimeProtocolSchemas.calls));
    for (const name of RUNTIME_PROTOCOL_CALL_NAMES) {
      expect(callSchemaNames.has(name), `missing schema for call '${name}'`).toBe(true);
    }
  });

  it('every schema call entry maps to a known protocol call', () => {
    const protocolCallNames = new Set<string>(RUNTIME_PROTOCOL_CALL_NAMES);
    for (const name of Object.keys(runtimeProtocolSchemas.calls)) {
      expect(protocolCallNames.has(name), `unknown schema entry for call '${name}'`).toBe(true);
    }
  });

  it('every call schema declares both args and result validators', () => {
    for (const [name, entry] of Object.entries(runtimeProtocolSchemas.calls)) {
      expect(entry.args, `call '${name}' missing args schema`).toBeDefined();
      expect(entry.result, `call '${name}' missing result schema`).toBeDefined();
    }
  });

  it('every protocol notify has a matching schema entry', () => {
    const notifySchemaNames = new Set(Object.keys(runtimeProtocolSchemas.notifies));
    for (const name of RUNTIME_PROTOCOL_NOTIFY_NAMES) {
      expect(notifySchemaNames.has(name), `missing schema for notify '${name}'`).toBe(true);
    }
  });

  it('every schema notify entry maps to a known protocol notify', () => {
    const protocolNotifyNames = new Set<string>(RUNTIME_PROTOCOL_NOTIFY_NAMES);
    for (const name of Object.keys(runtimeProtocolSchemas.notifies)) {
      expect(protocolNotifyNames.has(name), `unknown schema entry for notify '${name}'`).toBe(true);
    }
  });

  it('exposes exactly the protocol inventory: 2 calls + 18 notifies', () => {
    expect(Object.keys(runtimeProtocolSchemas.calls)).toHaveLength(2);
    expect(Object.keys(runtimeProtocolSchemas.notifies)).toHaveLength(18);
  });
});
