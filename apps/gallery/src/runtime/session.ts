import type { RuntimeClient, RuntimeDocument, ViewSubscription } from '@taucad/runtime/client';
import type { KernelIssue } from '@taucad/runtime/types';
import { admitParameterValues } from '@taucad/parameters';
import { copyParameters, resolveGalleryParameters } from '#runtime/parameters.js';
import type {
  GalleryExportFormat,
  GalleryOperationOptions,
  GalleryRenderResult,
  GallerySession,
  GallerySessionInput,
  GallerySessionOptions,
} from '#runtime/types.js';

const exportFormats: readonly GalleryExportFormat[] = ['glb', 'stl', '3mf', 'obj', 'step'];

const aborted = (message = 'The gallery operation was cancelled.'): DOMException =>
  new DOMException(message, 'AbortError');

const runtimeError = (operation: string, issues: readonly KernelIssue[]): Error =>
  new Error(`${operation}: ${issues.map((issue) => issue.message).join('; ') || 'the runtime returned no result'}`);

/** Editors can display partial geometry; gallery results must represent a completed model. */
const assertNoErrorIssues = (operation: string, issues: readonly KernelIssue[]): void => {
  const errors = issues.filter(({ severity }) => severity === 'error');
  if (errors.length > 0) {
    throw runtimeError(operation, errors);
  }
};

/** An aborted caller stops waiting without leaving an unhandled runtime operation behind. */
const withSignal = async <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  const cancellation = Promise.withResolvers<never>();
  const onAbort = (): void => {
    cancellation.reject(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  try {
    return await Promise.race([operation, cancellation.promise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
};

/** Shared session policy; only the entry point knows how its runtime is hosted. */
export const createGallerySessionWithClient = async (
  client: RuntimeClient,
  input: GallerySessionInput,
  options: GallerySessionOptions = {},
): Promise<GallerySession> => {
  const sessionLifetime = new AbortController();
  let document: RuntimeDocument | undefined;
  let view: ViewSubscription | undefined;
  let activeRender: AbortController | undefined;
  let latestRender: Promise<GalleryRenderResult> | undefined;
  let shutdown: Promise<void> | undefined;
  let abortDisposal: Promise<void> | undefined;
  let unsubscribeProgress: (() => void) | undefined;

  const dispose = async (): Promise<void> => {
    if (shutdown) {
      return shutdown;
    }
    options.signal?.removeEventListener('abort', onLifetimeAbort);
    sessionLifetime.abort(aborted('The gallery session was closed.'));
    activeRender?.abort(aborted('The gallery session was closed.'));
    unsubscribeProgress?.();
    view?.close();
    document?.close();
    shutdown = client.shutdown();
    return shutdown;
  };
  const disposeAfterAbort = async (): Promise<void> => {
    try {
      await dispose();
    } catch {
      // The cached shutdown promise retains the failure for callers awaiting session.dispose().
    }
  };
  const onLifetimeAbort = (): void => {
    abortDisposal = disposeAfterAbort();
  };
  options.signal?.addEventListener('abort', onLifetimeAbort, { once: true });

  try {
    options.signal?.throwIfAborted();
    const files = Object.fromEntries(
      Object.entries(input.files).map(([path, content]): [string, string | Uint8Array<ArrayBuffer>] => [
        path,
        typeof content === 'string' ? content : new Uint8Array(content),
      ]),
    );
    if (!Object.hasOwn(files, input.entryPath)) {
      throw new Error(`The model entry file is missing: ${input.entryPath}`);
    }
    const source = { files, entry: input.entryPath };
    options.onProgress?.({ phase: 'describing' });
    const description = await client.describe({ source, signal: sessionLifetime.signal });
    if (!description.success) {
      throw runtimeError('Could not read model parameters', description.issues);
    }
    assertNoErrorIssues('Could not read model parameters', description.issues);
    const parameterManifest = description.parameters;
    const defaultParameters = copyParameters(parameterManifest.defaults);
    const jsonSchema =
      parameterManifest.legacyProjection.status === 'usable' ? parameterManifest.legacyProjection.schema : undefined;
    let currentParameters = resolveGalleryParameters(defaultParameters, input.parameters ?? {});
    admitParameterValues(parameterManifest, currentParameters);
    const model = client.open({ source, parameters: currentParameters, watch: false, signal: sessionLifetime.signal });
    document = model;
    if (options.onProgress) {
      unsubscribeProgress = model.on('progress', options.onProgress);
    }

    const render = async (
      parameters?: Readonly<Record<string, unknown>>,
      operation: GalleryOperationOptions = {},
    ): Promise<GalleryRenderResult> => {
      activeRender?.abort(aborted('A newer parameter change replaced this render.'));
      const attempt = new AbortController();
      activeRender = attempt;
      const signal = AbortSignal.any([
        sessionLifetime.signal,
        attempt.signal,
        ...(operation.signal ? [operation.signal] : []),
      ]);
      currentParameters =
        parameters === undefined ? currentParameters : resolveGalleryParameters(defaultParameters, parameters);
      const effectiveParameters = copyParameters(currentParameters);

      const run = async (): Promise<GalleryRenderResult> => {
        signal.throwIfAborted();
        admitParameterValues(parameterManifest, effectiveParameters);
        const outcome = await withSignal(
          parameters === undefined ? model.evaluation({ signal }) : model.update({ parameters: effectiveParameters }),
          signal,
        );
        signal.throwIfAborted();
        if (outcome.superseded) {
          throw aborted('A newer parameter change replaced this evaluation.');
        }
        const { evaluation } = outcome;
        if (!evaluation.success) {
          throw runtimeError('Could not evaluate the model', evaluation.issues);
        }
        assertNoErrorIssues('Could not evaluate the model', evaluation.issues);
        const offered = evaluation.views.find(({ id }) => id === 'model') ?? evaluation.views[0];
        if (!offered) {
          throw new Error('The model did not produce a view.');
        }
        if (!view || view.view !== offered.id) {
          view?.close();
          view = model.view(offered.id, {
            ...(input.renderOptions?.tessellation === undefined
              ? {}
              : { options: { tessellation: input.renderOptions.tessellation } }),
            ...(input.renderOptions?.includeEdges === undefined
              ? {}
              : { content: { includeEdges: input.renderOptions.includeEdges } }),
          });
        }
        const projection = await view.rendering({ signal });
        signal.throwIfAborted();
        if (projection.superseded || projection.rendering.evaluationId !== evaluation.id) {
          throw aborted('A newer evaluation replaced this view.');
        }
        const { rendering } = projection;
        if (!rendering.success) {
          throw runtimeError('Could not render the model', rendering.issues);
        }
        assertNoErrorIssues('Could not render the model', rendering.issues);
        return {
          artifact: rendering.artifact,
          artifactHash: rendering.hash,
          jsonSchema,
          parameterManifest,
          defaultParameters: copyParameters(defaultParameters),
          parameters: effectiveParameters,
          formats: exportFormats.filter((format) => {
            const route = client.bestRouteFor(format, { kernelId: description.kernelId });
            return route !== undefined && evaluation.exports.some(({ extension }) => extension === route.sourceFormat);
          }),
          issues: [...description.issues, ...evaluation.issues, ...rendering.issues],
        };
      };
      latestRender = run();
      return latestRender;
    };

    const waitForCurrentRender = async (signal: AbortSignal): Promise<GalleryRenderResult> => {
      for (;;) {
        const pending = latestRender ?? render();
        try {
          // oxlint-disable-next-line no-await-in-loop -- a newer slider update can supersede the render an export awaits.
          const result = await withSignal(pending, signal);
          if (pending === latestRender) {
            return result;
          }
        } catch (error) {
          if (signal.aborted || pending === latestRender) {
            throw error;
          }
        }
      }
    };

    return {
      render,
      async export(format, operation = {}) {
        const signal = AbortSignal.any([sessionLifetime.signal, ...(operation.signal ? [operation.signal] : [])]);
        signal.throwIfAborted();
        const result = await waitForCurrentRender(signal);
        if (!result.formats.includes(format)) {
          throw new Error(`This model cannot be exported as ${format.toUpperCase()}.`);
        }
        const exported = await model.export(format, { signal });
        signal.throwIfAborted();
        if (!exported.success) {
          throw runtimeError(`Could not export ${format.toUpperCase()}`, exported.issues);
        }
        assertNoErrorIssues(`Could not export ${format.toUpperCase()}`, exported.issues);
        return exported.files.map(({ name, bytes, mimeType }) => ({ name, bytes, mimeType }));
      },
      async dispose() {
        await abortDisposal;
        await dispose();
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
};
