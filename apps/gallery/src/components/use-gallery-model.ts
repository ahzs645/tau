import { useEffect, useMemo, useState } from 'react';
import { loadProjectFiles } from '#catalog/catalog.js';
import type { GalleryFiles, GalleryProject, GalleryVariant } from '#catalog/types.js';
import { createGallerySession, loadGalleryStaticArtifact } from '#runtime.js';
import type { GalleryRenderResult, GallerySession } from '#runtime.js';
import { errorMessage } from '#components/download.js';

export type UploadedAsset = {
  readonly name: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mimeType: string;
};
export type UploadedAssets = Readonly<Record<string, UploadedAsset>>;
const emptyFiles: GalleryFiles = {};

const disposeSession = async (session: GallerySession): Promise<void> => {
  try {
    await session.dispose();
  } catch (error) {
    console.warn('The gallery worker could not be released.', error);
  }
};

type ModelInput = {
  readonly project: GalleryProject;
  readonly variant?: GalleryVariant;
  readonly parameters: Record<string, unknown>;
  readonly uploads: UploadedAssets;
  readonly operationTimeout: number;
  readonly retry: number;
};

type GalleryModelState = {
  readonly result?: GalleryRenderResult;
  readonly session?: GallerySession;
  readonly files: GalleryFiles;
  readonly status: 'loading' | 'rendering' | 'ready' | 'error';
  readonly error?: string;
  readonly busy: boolean;
};

/** Own a runtime session for one source revision; parameter edits reuse its worker. */
export const useGalleryModel = ({
  project,
  variant,
  parameters,
  uploads,
  operationTimeout,
  retry,
}: ModelInput): GalleryModelState => {
  const identity = `${project.id}:${variant?.id ?? 'static'}`;
  const source = useMemo(
    () => ({ project, variant, uploads, operationTimeout, retry }),
    [project, variant, uploads, operationTimeout, retry],
  );
  const [resource, setResource] = useState<{
    readonly identity: string;
    readonly source: typeof source;
    readonly session: GallerySession;
    readonly files: GalleryFiles;
  }>();
  const [rendered, setRendered] = useState<{
    readonly identity: string;
    readonly source: typeof source;
    readonly parameters?: Record<string, unknown>;
    readonly result: GalleryRenderResult;
  }>();
  const [status, setStatus] = useState<'loading' | 'rendering' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    let activeSession: GallerySession | undefined;
    setResource(undefined);
    setStatus('loading');
    setError(undefined);

    const open = async (): Promise<void> => {
      try {
        if (project.mode === 'static') {
          if (!project.staticPreviewUrl) {
            throw new Error('This project has no preview asset.');
          }
          const result = await loadGalleryStaticArtifact(project.staticPreviewUrl, {
            signal: controller.signal,
            coordinateSystem: project.staticPreviewCoordinateSystem,
          });
          if (!controller.signal.aborted) {
            setRendered({ identity, source, result });
            setStatus('ready');
          }
          return;
        }
        if (!variant) {
          throw new Error('This project has no CAD variant.');
        }
        const files = await loadProjectFiles(project.id, variant.id, controller.signal);
        for (const [path, asset] of Object.entries(uploads)) {
          files[path] = asset.bytes;
        }
        const session = await createGallerySession(
          {
            kernel: variant.kernel,
            entryPath: variant.entry,
            files,
            operationTimeout,
            renderOptions: variant.renderOptions,
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) {
          await session.dispose();
          return;
        }
        activeSession = session;
        setResource({ identity, source, session, files });
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(errorMessage(error));
          setStatus('error');
        }
      }
    };
    void open();
    return () => {
      controller.abort();
      if (activeSession) {
        void disposeSession(activeSession);
      }
    };
  }, [identity, project, variant, uploads, operationTimeout, retry, source]);

  useEffect(() => {
    if (!resource || resource.identity !== identity || resource.source !== source) {
      return;
    }
    const controller = new AbortController();
    setStatus('rendering');
    setError(undefined);
    const render = async (): Promise<void> => {
      try {
        const result = await resource.session.render(parameters, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setRendered({ identity, source, parameters, result });
          setStatus('ready');
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(errorMessage(error));
          setStatus('error');
        }
      }
    };
    void render();
    return () => {
      controller.abort();
    };
  }, [resource, identity, parameters, source]);

  const result = rendered?.identity === identity ? rendered.result : undefined;
  const matchesRequest =
    rendered?.source === source && (project.mode === 'static' || rendered.parameters === parameters);
  const currentStatus = status === 'ready' && !matchesRequest ? 'rendering' : status;
  return useMemo(
    () => ({
      result,
      session: resource?.identity === identity && resource.source === source ? resource.session : undefined,
      files: resource?.identity === identity ? resource.files : emptyFiles,
      status: currentStatus,
      error,
      busy: currentStatus === 'loading' || currentStatus === 'rendering',
    }),
    [result, resource, identity, source, currentStatus, error],
  );
};
