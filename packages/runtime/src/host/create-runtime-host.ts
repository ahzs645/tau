/**
 * `createRuntimeHost` — symmetric host-side entry point that mirrors
 * {@link createRuntimeClient}.
 *
 * Consumers compose a pre-built {@link RuntimeTransportHost} (returned
 * `electronUtilityHost({ fileSystem })`) and the runtime drives `open()` /
 * `close()` lifecycle. The runtime core stays wire-agnostic.
 */

import type { RuntimeHostConfig, RuntimeHostHandle } from '#host/runtime-host.types.js';

/**
 * Identity helper that returns the supplied {@link RuntimeHostConfig}
 * untouched. Useful when authoring host configs in a separate module
 * so call sites get full intellisense without importing the
 * `RuntimeHostConfig` type explicitly.
 *
 * @param config - The host configuration.
 * @returns The same configuration object, typed.
 *
 * @public
 *
 * @example <caption>Author host config separately from the host bootstrap</caption>
 * ```typescript
 * import { createRuntimeHostConfig } from '@taucad/runtime/host';
 * import { electronUtilityHost } from './my-electron-transport';
 * import { fromNodeFs } from '@taucad/runtime/filesystem/node';
 *
 * export const hostConfig = createRuntimeHostConfig({
 *   transport: electronUtilityHost({ fileSystem: fromNodeFs('/tmp/project') }),
 * });
 * ```
 */
export function createRuntimeHostConfig(config: RuntimeHostConfig): RuntimeHostConfig {
  return config;
}

/**
 * Create a runtime host bound to the supplied transport.
 *
 * @param config - {@link RuntimeHostConfig}.
 * @returns A {@link RuntimeHostHandle} with `dispose()` for symmetric
 *   teardown.
 *
 * @public
 *
 * @example <caption>Headless Node host with a transport that accepts host options</caption>
 * ```typescript
 * import { createRuntimeHost } from '@taucad/runtime/host';
 * import { fromNodeFs } from '@taucad/runtime/filesystem/node';
 * import { electronUtilityHost } from './electron-utility-transport';
 *
 * const host = createRuntimeHost({
 *   transport: electronUtilityHost({
 *     fileSystem: fromNodeFs('/path/to/projects'),
 *   }),
 * });
 *
 * // ... later
 * host.dispose();
 * ```
 */
export function createRuntimeHost(config: RuntimeHostConfig): RuntimeHostHandle {
  const { transport } = config;
  let disposed = false;
  const { id } = transport;

  const startPromise = startTransport(transport);

  return {
    id,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      void disposeTransport(startPromise, transport);
    },
  };
}

const startTransport = async (
  transport: RuntimeHostConfig['transport'],
): Promise<{ readonly ready: Awaited<ReturnType<RuntimeHostConfig['transport']['open']>> }> => {
  try {
    const ready = await transport.open();
    return { ready };
  } catch (error) {
    throw new Error(
      `createRuntimeHost: transport '${transport.id}' failed to start: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
};

const disposeTransport = async (
  startPromise: ReturnType<typeof startTransport>,
  transport: RuntimeHostConfig['transport'],
): Promise<void> => {
  try {
    const { ready } = await startPromise;
    try {
      ready.channel.dispose();
    } catch {
      /* Best-effort */
    }
    try {
      await transport.close();
    } catch {
      /* Best-effort */
    }
  } catch {
    /* Startup failed — nothing to dispose */
  }
};
