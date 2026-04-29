// @vitest-environment node
/**
 * Kernel Integration Test — v6 rewrite pending.
 *
 * The original suite was authored against the v5 runtime API
 * (`inProcessRunner()` + `client.connect({ fileSystem })`) and exercised
 * the production wiring between `WorkspaceFileService`, the filesystem
 * bridge, `createRuntimeClient`, and multi-kernel selection to
 * deterministically reproduce an empty-geometry failure mode.
 *
 * v6 moved filesystem ownership into the transport client at construction
 * time and removed `RuntimeFileSystemBase` as a public adapter input —
 * the opaque `RuntimeFileSystem` is produced exclusively via the bundled
 * `fromX` factories (`fromMemoryFs`, `fromFsLikeOpaque`,
 * `fromWorkerOpaque`, `fromBrowserFs`, `fromNodeFs`, `fromChannelFs`).
 *
 * Rewriting the suite for v6 requires either:
 *   1. A new public adapter (`fromRuntimeFileSystemBase` parallel to the
 *      v5 `fromInline`) so `WorkspaceFileService` can be wrapped opaquely
 *      and handed to `inProcessTransport.client({ fileSystem })`, OR
 *   2. A test refactor that drives the production bridge end-to-end via
 *      `fromChannelFs` + `createBridgeServer` against a real WSFS host.
 *
 * Tracked as Stage-7 follow-up `s7-ui-integration-test`.
 */

import { describe, it } from 'vitest';

describe.skip('Kernel Integration — WorkspaceFileService bridge (v6 rewrite pending)', () => {
  it.todo('rewrite Layer 1 — bridge readFile/exists round-trip');
  it.todo('rewrite Layer 2 — RuntimeClient + WSFS bridge (export non-empty GLB)');
  it.todo('rewrite Layer 3 — event-driven setFile path produces non-empty geometry');
  it.todo('rewrite Layer 4 — fromMemoryFs control path (known-good inline code)');
  it.todo('rewrite Layer 5 — edit-then-fetch via openFile + fresh-render events');
});
