import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileExtension, Geometry } from '@taucad/types';
import type {
  RuntimeClient,
  CapabilitiesManifest,
  RuntimeClientOptions,
  ExportResult,
  KernelPlugin,
  TranscoderPlugin,
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
 * Headless hook for transient, in-memory CAD rendering.
 *
 * Creates a `RuntimeClient` internally, calls `client.render({ code })` reactively
 * when inputs change, and returns geometry results. Uses an in-memory filesystem.
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
 * const code = 'export default () => ({ type: "box", size: 10 })';
 *
 * const { geometries, status } = useRender({
 *   clientOptions: options,
 *   code: { 'main.ts': code },
 * });
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
  // oxlint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- intentional: documents the wide-default erasure form per R6
  const clientRef = useRef<RuntimeClient<KernelPlugin[], TranscoderPlugin[]> | undefined>(undefined);

  useEffect(() => {
    const client = createRuntimeClient(clientOptions);
    clientRef.current = client;

    const unsubParams = client.on('parametersResolved', (result) => {
      if (result.success) {
        setDefaultParameters(result.data.defaultParameters);
        setJsonSchema(result.data.jsonSchema as JSONSchema7);
      }
    });

    const unsubCaps = client.on('capabilities', (manifest) => {
      setCapabilities(manifest);
    });

    return () => {
      unsubParams();
      unsubCaps();
      client.terminate();
      clientRef.current = undefined;
    };
  }, [clientOptions]);

  useEffect(() => {
    const client = clientRef.current;
    if (!client || !enabled) {
      return;
    }

    let cancelled = false;
    setStatus('loading');

    const resolvedFile = file ?? Object.keys(code)[0]!;

    void (async () => {
      try {
        const result = await client.render({ code, file: resolvedFile, parameters });

        // oxlint-disable-next-line eslint/no-constant-condition, typescript/no-unnecessary-condition -- cancelled is mutated by cleanup after await
        if (cancelled) {
          return;
        }

        if (result.success) {
          setGeometries(result.data);
          setError(undefined);
          setStatus('success');
          setCapabilities(client.capabilities);
        } else {
          const firstIssue = result.issues[0];
          setError(new Error(firstIssue?.message ?? 'Render failed'));
          setStatus('error');
        }
      } catch (error) {
        // oxlint-disable-next-line eslint/no-constant-condition, typescript/no-unnecessary-condition -- cancelled is mutated by cleanup after await
        if (cancelled) {
          return;
        }

        setError(error instanceof Error ? error : new Error(String(error)));
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, file, parameters, enabled]);

  const exportGeometry = useCallback(
    async (format: FileExtension, formatOptions?: Record<string, unknown>): Promise<ExportResult> => {
      const client = clientRef.current;
      if (!client) {
        return { success: false, issues: [{ message: 'Runtime client not initialized', severity: 'error' }] };
      }
      return client.export(format, formatOptions);
    },
    [],
  );

  return { geometries, status, error, defaultParameters, jsonSchema, exportGeometry, capabilities };
}
