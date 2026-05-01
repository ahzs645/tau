/* oxlint-disable no-barrel-files/no-barrel-files -- public topology subpath barrel */

/**
 * Same-isolate transport entry — `@taucad/runtime/transport/in-process`.
 *
 * Hosts {@link inProcessTransport}, which keeps client and host in the
 * same V8 isolate and bridges them through an internal
 * `MessageChannel` so the channel protocol stays uniform with the
 * cross-isolate transports. Cross-environment by construction:
 * `MessageChannel` is a global in Node.js (since v15) and every
 * modern browser, so this subpath is safe to import from any topology
 * (CLI, server, browser, test harness).
 *
 * Lives at its own subpath (parallel to `/transport/web` and
 * `/transport/node`) so every concrete transport ships behind an
 * explicit topology-tagged import path. The universal
 * `@taucad/runtime/transport` barrel intentionally stays minimal —
 * author API (`defineRuntimeTransport`), wire validators, and types.
 *
 * @public
 */

export { inProcessTransport } from '#transport/in-process-transport.js';
