import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileExtension, Geometry } from '@taucad/types';
import type {
  RuntimeClient,
  CapabilitiesManifest,
  RuntimeClientOptions,
  ExportResult,
  KernelPlugin,
  TranscoderPlugin,
  HashedGeometryResult,
} from '@taucad/runtime';
import { createRuntimeClient } from '@taucad/runtime';
import type { JSONSchema7 } from '@taucad/json-schema';

/**
 * Status of a transient render operation.
 *
 * @public
 */
export type RenderStatus = 'idle' | 'loading' | 'success' | 'error';

/**
 * Options for the {@link useRender} hook.
 *
 * Callers must provide a stable `clientOptions` reference (via module-level
 * `createRuntimeClientOptions` or `useMemo`). Changing the reference triggers
 * a new client lifecycle (terminate old, create new).
 *
 * @public
 */
export type UseRenderOptions = {
  /** Runtime client configuration (kernels, bundlers, middleware). */
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- accept any kernel/transcoder generics
  readonly clientOptions: RuntimeClientOptions<any, any>;
  /** Filename-to-content map of source code to render. */
  readonly code: Record<string, string>;
  /** Entry point filename. Required when `code` has multiple keys; inferred for single-key maps. */
  readonly file?: string;
  /** Parameters passed to the kernel for parametric models. */
  readonly parameters?: Record<string, unknown>;
  /** When false, defers rendering until set to true. Defaults to true. */
  readonly enabled?: boolean;
};

/**
 * Return value of the {@link useRender} hook.
 *
 * @public
 */
export type UseRenderResult = {
  /** Rendered geometries (empty until first successful render). */
  readonly geometries: Geometry[];
  /** Current status of the render lifecycle. */
  readonly status: RenderStatus;
  /** Error from the most recent render attempt, if any. */
  readonly error: Error | undefined;
  /** Default parameter values extracted from the model. */
  readonly defaultParameters: Record<string, unknown>;
  /** JSON Schema describing the model's parameters. */
  readonly jsonSchema: JSONSchema7 | undefined;
  /** Export the last render result to the specified format. Only available after a successful render. */
  readonly exportGeometry: (format: FileExtension, options?: Record<string, unknown>) => Promise<ExportResult>;
  /** Capabilities manifest from the runtime worker, available after initialization. */
  readonly capabilities: CapabilitiesManifest | undefined;
};

const emptyGeometries: Geometry[] = [];
const emptyParameters: Record<string, unknown> = {};

/**
 * Headless hook for transient, in-memory CAD rendering using the v5
 * event-driven `RuntimeClient` surface.
 *
 * The hook owns the four-step lifecycle on the consumer's behalf:
 *
 * 1. **Construct** — `createRuntimeClient(clientOptions)` on `clientOptions`
 *    change (or first mount).
 * 2. **Connect** — subscribes to `client.on('geometry' | 'error' | 'parametersResolved' | 'capabilities', …)`
 *    and lets the runtime client establish its transport handshake.
 * 3. **Command** — `client.openFile({ code, file, parameters })` is invoked
 *    whenever `code`, `file`, `parameters`, or `enabled` changes. Multiple
 *    rapid changes naturally supersede each other via `RenderOutcome` —
 *    the prior settlement resolves with `{ superseded: true }` and the
 *    latest call's geometry arrives over the `'geometry'` event channel.
 * 4. **Consume** — geometries, status, parameter schema, and capabilities
 *    are exposed as React state, updating reactively as worker events
 *    flow through the event surface.
 *
 * Cleanup terminates the client on unmount. Subscriptions auto-dispose.
 *
 * @param options - Render configuration including code, kernels, and parameters
 * @returns Reactive render state including geometries, status, error, and parameter schema
 * @public
 *
 * @example <caption>Render a CAD model with replicad and esbuild</caption>
 * ```typescript
 * import { useRender } from '@taucad/react';
 * import { createRuntimeClientOptions } from '@taucad/runtime';
 * import { replicad } from '@taucad/runtime/kernels';
 * import { esbuild } from '@taucad/runtime/bundler';
 *
 * const options = createRuntimeClientOptions({
 *   kernels: [replicad()],
 *   bundlers: [esbuild()],
 * });
 *
 * const code = `
 *   import { drawCircle } from 'replicad';
 *   export default () => drawCircle(10).sketchOnPlane().extrude(20);
 * `;
 *
 * const { geometries, status, error } = useRender({
 *   clientOptions: options,
 *   code: { '/main.ts': code },
 *   file: '/main.ts',
 *   parameters: { height: 20 },
 * });
 *
 * if (status === 'success') {
 *   // geometries[0].format === 'gltf' for the default replicad pipeline
 * }
 * ```
 */
export function useRender(options: UseRenderOptions): UseRenderResult {
  const { clientOptions, code, file, parameters, enabled = true } = options;

  const [geometries, setGeometries] = useState<Geometry[]>(emptyGeometries);
  const [status, setStatus] = useState<RenderStatus>('idle');
  const [error, setError] = useState<Error | undefined>();
  const [defaultParameters, setDefaultParameters] = useState<Record<string, unknown>>(emptyParameters);
  const [jsonSchema, setJsonSchema] = useState<JSONSchema7 | undefined>();

  const [capabilities, setCapabilities] = useState<CapabilitiesManifest | undefined>();
  // oxlint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- intentional: documents the wide-default erasure form
  const clientRef = useRef<RuntimeClient<KernelPlugin[], TranscoderPlugin[]> | undefined>(undefined);

  useEffect(() => {
    const client = createRuntimeClient(clientOptions);
    clientRef.current = client;

    const unsubscribers: Array<() => void> = [];

    unsubscribers.push(
      client.on('parametersResolved', (result) => {
        if (result.success) {
          setDefaultParameters(result.data.defaultParameters);
          setJsonSchema(result.data.jsonSchema as JSONSchema7);
        }
      }),
      client.on('capabilities', (manifest) => {
        setCapabilities(manifest);
      }),
      client.on('geometry', (result: HashedGeometryResult) => {
        if (result.success) {
          setGeometries(result.data);
          setError(undefined);
          setStatus('success');
        } else {
          const firstIssue = result.issues[0];
          setError(new Error(firstIssue?.message ?? 'Render failed'));
          setStatus('error');
        }
      }),
      client.on('error', (issues) => {
        const firstIssue = issues[0];
        setError(new Error(firstIssue?.message ?? 'Render failed'));
        setStatus('error');
      }),
    );

    return () => {
      for (const unsub of unsubscribers) {
        unsub();
      }
      client.terminate();
      clientRef.current = undefined;
    };
  }, [clientOptions]);

  useEffect(() => {
    const client = clientRef.current;
    if (!client || !enabled) {
      return;
    }

    setStatus('loading');

    const resolvedFile = file ?? Object.keys(code)[0]!;

    // async-iife: bootstrap — openFile from effect; surface errors without blocking render
    void (async (): Promise<void> => {
      try {
        await client.openFile({ code, file: resolvedFile, parameters });
      } catch (error) {
        setError(error instanceof Error ? error : new Error(String(error)));
        setStatus('error');
      }
    })();
  }, [code, file, parameters, enabled]);

  const exportGeometry = useCallback(
    async (format: FileExtension, formatOptions?: Record<string, unknown>): Promise<ExportResult> => {
      const client = clientRef.current;
      if (!client) {
        return {
          success: false,
          issues: [{ message: 'Runtime client not initialized', code: 'RUNTIME', severity: 'error' }],
        };
      }
      return client.export(format, formatOptions);
    },
    [],
  );

  return { geometries, status, error, defaultParameters, jsonSchema, exportGeometry, capabilities };
}
