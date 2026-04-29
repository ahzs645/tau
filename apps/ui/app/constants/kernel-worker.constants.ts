import { replicad, opencascade, zoo, jscad, manifold, tau } from '@taucad/runtime/kernels';
import { openscad } from '@taucad/openscad';
import { parameterCache, geometryCache, gltfCoordinateTransform, gltfEdgeDetection } from '@taucad/runtime/middleware';
import { esbuild } from '@taucad/runtime/bundler';
import { converterTranscoder } from '@taucad/runtime/transcoder';
import { createRuntimeClientOptions } from '@taucad/runtime';
import { webWorkerTransport } from '@taucad/runtime/transport';
import { observability } from '@taucad/telemetry/middleware';
import { parameterFileResolver } from '#middleware/parameter-file-resolver.factory.js';
import { ENV } from '#environment.config.js';
import type { KernelOptionsFactory } from '#types/runtime-client.alias.js';

/**
 * Browser kernel-runtime worker URL.
 *
 * Vite analyses the literal `new URL('@taucad/runtime/worker',
 * import.meta.url)` at build time and emits the runtime worker as a
 * hashed renderer asset. The constant lives in module scope so the
 * URL resolves once per page-load and the resulting `URL` instance is
 * stable across kernel-option construction.
 */
const kernelWorkerUrl = new URL('@taucad/runtime/worker', import.meta.url);

/**
 * Default kernel array for the editor.
 *
 * Order defines selection priority — the first kernel that can handle
 * a file wins. Exported separately so consumers that only need plugin
 * metadata (e.g. Monaco language registration) can import the kernel
 * list without paying the cost of building a full transport client.
 */
export const defaultKernels = [
  openscad(),
  zoo({ baseUrl: `${ENV.TAU_WEBSOCKET_URL}/v1/kernels/zoo` }),
  replicad({ withBrepEdges: true }),
  opencascade(),
  manifold(),
  jscad(),
  tau(),
];

/**
 * Build the editor's default {@link RuntimeClientOptions} with a
 * web-worker transport configured for the supplied filesystem and
 * file-content pool.
 *
 * Wire topology — `webWorkerTransport`: the kernel runs in a dedicated
 * `Worker` spawned from `kernelWorkerUrl`. Cooperative abort is
 * SAB-backed (`Atomics.notify`); geometry transports as pooled SAB
 * delivery (declared via `sharedMemory.geometry`); the filesystem
 * bridges through a `MessagePort` to the FM worker.
 *
 * The filesystem handle and the file-pool `SharedArrayBuffer` are
 * owned by the file-manager machine and only available after it
 * reaches `ready`. They are passed in here so the transport client
 * is constructed with everything it needs up-front, preserving the
 * v6 invariant that `client.connect()` takes no arguments.
 */
export const createDefaultKernelOptions: KernelOptionsFactory = ({ fileSystem, filePoolBuffer }) =>
  createRuntimeClientOptions({
    transport: webWorkerTransport.client({
      url: kernelWorkerUrl,
      fileSystem,
      filePoolBuffer,
      sharedMemory: {
        geometry: { bytes: 100 * 1024 * 1024 },
      },
    }),
    kernels: defaultKernels,
    middleware: [
      observability({ reportUrl: `${ENV.TAU_API_URL}/v1/telemetry/ingest` }),
      parameterFileResolver(),
      parameterCache(),
      geometryCache(),
      gltfCoordinateTransform(),
      gltfEdgeDetection(),
    ],
    bundlers: [esbuild()],
    transcoders: [converterTranscoder()],
  });

/**
 * Debug kernel options for the editor.
 *
 * Identical to default but enables `withSourceMapping: true` on
 * replicad for enriched error stack traces with library source map
 * resolution. Adds ~50ms to init — only use where rich error feedback
 * matters.
 */
export const createDebugKernelOptions: KernelOptionsFactory = (deps) =>
  createRuntimeClientOptions(createDefaultKernelOptions(deps), {
    kernels: [
      replicad({
        withBrepEdges: true,
        withSourceMapping: true,
      }),
    ],
  });
