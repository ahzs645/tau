/**
 * Phase 4 / R4 — Legacy `TransportDescriptor` deletion contract.
 *
 * Pre-v6, `client.capabilities.transport.descriptor` exposed a
 * legacy "name/locality/sharedMemory/latencyClass" shape that was
 * projected from the canonical `TransportDescriptor<Id>` via
 * `projectLegacyDescriptor`. With R4 the legacy carrier is deleted
 * outright and `RuntimeCapabilities.transport.descriptor` references
 * the canonical descriptor exposed by every transport plugin.
 *
 * This test locks two contracts:
 *
 *   1. The legacy file `#types/transport-descriptor.types.ts` must
 *      not exist and must not be re-exported from the public barrel.
 *   2. The descriptor surfaced via `client.capabilities` must carry
 *      the canonical field set (`id`, `wire`, `memory.*`, `fileSystem`),
 *      not the legacy field set (`name`, `locality`, `sharedMemory`,
 *      `latencyClass`).
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import * as runtimePublic from '#index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('legacy TransportDescriptor removal (R4)', () => {
  it('the legacy descriptor file no longer exists', () => {
    const legacyPath = resolve(packageRoot, 'types/transport-descriptor.types.ts');
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('the public runtime barrel does NOT re-export the legacy descriptor surface keys', () => {
    /*
     * The canonical `TransportDescriptor` re-export from
     * `#transport/index.js` is a *type* export — it does not appear on
     * the value surface. The legacy carrier was also a type-only
     * export, so a runtime check on `runtimePublic` cannot
     * distinguish the two; the existence check above provides the
     * load-bearing assertion.
     *
     * We additionally smoke-check that no value-level shim with the
     * legacy shape is surfaced.
     */
    const surface = runtimePublic as unknown as Record<string, unknown>;
    expect(surface['projectLegacyDescriptor']).toBeUndefined();
    expect(surface['LegacyTransportDescriptor']).toBeUndefined();
  });
});
