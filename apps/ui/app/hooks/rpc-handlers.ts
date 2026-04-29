/**
 * RPC Handlers Browser Adapter
 *
 * Thin adapter that bridges browser-specific dependencies (fileManager, XState actors,
 * WebGL) to the transport-agnostic RPC handler interfaces in @taucad/chat/rpc.
 *
 * The core handler logic lives in libs/chat/src/rpc/handlers/. This module only
 * adapts browser-specific deps into the abstract RpcDependencies interface.
 */
import { createActor } from 'xstate';
import type { ActorRefFrom, SnapshotFrom } from 'xstate';
import { awaitFreshRender, AwaitFreshRenderTimeoutError } from '#lib/await-fresh-render.js';
import type {
  RpcCall,
  GetKernelResultRpcResult,
  CaptureObservationsRpcResult,
  CaptureScreenshotRpcResult,
  FetchGeometryRpcResult,
} from '@taucad/chat';
import { createRpcDispatcher } from '@taucad/chat/rpc';
import type {
  RpcDependencies,
  RpcFileSystem,
  RpcFileStat,
  RpcRuntimeClient,
  RpcGraphicsClient,
} from '@taucad/chat/rpc';
import type { FileEntry } from '@taucad/types';
import { idPrefix } from '@taucad/types/constants';
import { generatePrefixedId } from '@taucad/utils/id';

import { screenshotRequestMachine, orthographicViews } from '#machines/screenshot-request.machine.js';
import type { graphicsMachine } from '#machines/graphics.machine.js';
import type { projectMachine } from '#machines/project.machine.js';
import type { cadMachine } from '#machines/cad.machine.js';
import { decodeTextFile, encodeTextFile } from '#utils/filesystem.utils.js';

/** Source of file write operations */
type FileWriteSource = 'editor' | 'user' | 'machine';

/**
 * Resolves the per-viewer-panel graphics actor displaying a given source file.
 * Returns undefined if no panel currently displays that file.
 *
 * Multi-file aware: every agent-facing screenshot/observation flow looks up
 * the targeted geometry unit explicitly — there is no project-level
 * `mainEntryFile` fallback.
 */
export type ResolveGraphicsForFile = (targetFile: string) => ActorRefFrom<typeof graphicsMachine> | undefined;

/**
 * Dependencies required for RPC execution.
 */
export type RpcHandlerDependencies = {
  fileManager: {
    readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>>;
    writeFile: (path: string, data: Uint8Array<ArrayBuffer>, options: { source: FileWriteSource }) => Promise<void>;
    deleteFile: (path: string, options: { source: FileWriteSource }) => Promise<void>;
    stat: (path: string) => Promise<{ type: 'file' | 'dir'; size: number; mtimeMs: number }>;
  };
  /**
   * Function that maps a source file path to its viewer panel's graphics actor.
   * Pass `undefined` in headless modes where no view is mounted.
   */
  resolveGraphicsForFile: ResolveGraphicsForFile | undefined;
  projectRef: ActorRefFrom<typeof projectMachine>;
  treeService:
    | {
        getTreeSnapshot(): Map<string, FileEntry>;
        exists(path: string): Promise<boolean>;
        readDirectoryEntries(path: string): Promise<Array<{ id?: string; name: string; children?: unknown[] }>>;
      }
    | undefined;
  screenshotQuality: number;
};

/**
 * RPC call input structure with toolCallId.
 */
export type RpcCallInput = RpcCall & {
  toolCallId: string;
};

function createBrowserRpcFileSystem(
  fileManager: RpcHandlerDependencies['fileManager'],
  treeService: RpcHandlerDependencies['treeService'],
): RpcFileSystem {
  return {
    async readFile(path: string): Promise<string> {
      const data = await fileManager.readFile(path);
      return decodeTextFile(data);
    },
    async writeFile(path: string, content: string): Promise<void> {
      await fileManager.writeFile(path, encodeTextFile(content), {
        source: 'machine',
      });
    },
    async writeBinaryFile(path: string, data: Uint8Array<ArrayBuffer>): Promise<void> {
      await fileManager.writeFile(path, new Uint8Array(data), { source: 'machine' });
    },
    async deleteFile(path: string): Promise<void> {
      await fileManager.deleteFile(path, { source: 'machine' });
    },
    async readdir(
      path: string,
    ): Promise<Array<{ name: string; type: 'file' | 'dir'; size: number; modifiedAt?: string }>> {
      if (!treeService) {
        return [];
      }
      const nodes = await treeService.readDirectoryEntries(path);
      return nodes.map((node) => ({
        name: node.name,
        type: node.children === undefined ? 'file' : 'dir',
        size: 0,
      }));
    },
    async exists(path: string): Promise<boolean> {
      if (!treeService) {
        return false;
      }
      return treeService.exists(path);
    },
    async appendFile(path: string, content: string): Promise<void> {
      let existing = '';
      try {
        const data = await fileManager.readFile(path);
        existing = decodeTextFile(data);
      } catch {
        // File doesn't exist yet — will be created
      }

      await fileManager.writeFile(path, encodeTextFile(existing + content), {
        source: 'machine',
      });
    },
    // oxlint-disable-next-line max-params -- list of args is consistent with other file operations
    async editFile(
      path: string,
      oldString: string,
      newString: string,
      replaceAll?: boolean,
    ): Promise<{ occurrences: number }> {
      const data = await fileManager.readFile(path);
      const content = decodeTextFile(data);

      let updated: string;
      let occurrences: number;

      if (replaceAll) {
        occurrences = content.split(oldString).length - 1;
        updated = occurrences > 0 ? content.replaceAll(oldString, newString) : content;
      } else {
        occurrences = content.includes(oldString) ? 1 : 0;
        updated = occurrences > 0 ? content.replace(oldString, newString) : content;
      }

      if (occurrences === 0) {
        throw new Error(`String not found in ${path}`);
      }

      await fileManager.writeFile(path, encodeTextFile(updated), { source: 'machine' });
      return { occurrences };
    },
    async stat(path: string): Promise<RpcFileStat> {
      const s = await fileManager.stat(path);
      const isoDate = new Date(s.mtimeMs).toISOString();
      return {
        size: s.size,
        isDirectory: s.type === 'dir',
        createdAt: isoDate,
        modifiedAt: isoDate,
      };
    },
  };
}

/**
 * Resolves the compilation-unit actor for `targetFile`, bootstrapping it via
 * `createGeometryUnit` if it does not already exist, then awaits a *fresh*
 * render to settle (per `awaitFreshRender` in `apps/ui/app/lib/`).
 *
 * Both `getKernelResult` and `fetchGeometry` route through this helper so they
 * share a single bootstrap contract — the agent never sees a missing-geometry
 * unit error for a path it just asked the harness to evaluate, and never sees
 * a stale geometry from a prior render generation.
 */
type EnsureGeometryUnitResult =
  | {
      ok: true;
      cadUnit: ActorRefFrom<typeof cadMachine>;
      cadSnapshot: SnapshotFrom<typeof cadMachine>;
    }
  | {
      ok: false;
      errorCode: 'UNKNOWN' | 'RENDER_TIMEOUT';
      message: string;
    };

async function ensureGeometryUnit(
  projectRef: ActorRefFrom<typeof projectMachine>,
  targetFile: string,
): Promise<EnsureGeometryUnitResult> {
  try {
    const projectSnapshot = projectRef.getSnapshot();
    const { geometryUnits } = projectSnapshot.context;
    let cadUnit = geometryUnits.get(targetFile);

    if (!cadUnit) {
      projectRef.send({
        type: 'createGeometryUnit',
        entryFile: targetFile,
      });
      const refreshed = projectRef.getSnapshot();
      cadUnit = refreshed.context.geometryUnits.get(targetFile);
    }

    if (!cadUnit) {
      return {
        ok: false,
        errorCode: 'UNKNOWN',
        message: `Failed to create geometry unit for ${targetFile}`,
      };
    }

    const cadSnapshot = await awaitFreshRender(cadUnit);

    return { ok: true, cadUnit, cadSnapshot };
  } catch (error) {
    if (error instanceof AwaitFreshRenderTimeoutError) {
      return {
        ok: false,
        errorCode: 'RENDER_TIMEOUT',
        message: `Render for ${targetFile} did not settle in time. Try a simpler model or wait and retry.`,
      };
    }
    return {
      ok: false,
      errorCode: 'UNKNOWN',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Heuristic check: does a kernelIssue message look like a "file not found"
 * diagnostic for the file the agent asked about? Kept permissive on purpose —
 * different kernels word the failure differently (Node `ENOENT`, OpenSCAD
 * `does not exist`, generic `not found`). Falls back to UNKNOWN if no signal.
 */
function isFileNotFoundMessage(message: string, targetFile: string): boolean {
  if (!/enoent|not found|does not exist/i.test(message)) {
    return false;
  }
  return message.toLowerCase().includes(targetFile.toLowerCase());
}

function createBrowserRuntimeClient(projectRef: ActorRefFrom<typeof projectMachine>): RpcRuntimeClient {
  return {
    async getKernelResult(targetFile: string): Promise<GetKernelResultRpcResult> {
      const resolved = await ensureGeometryUnit(projectRef, targetFile);
      if (!resolved.ok) {
        return { success: false, errorCode: resolved.errorCode, message: resolved.message };
      }

      const { cadSnapshot } = resolved;
      const kernelIssues = cadSnapshot.context.kernelIssues.get(targetFile);
      const hasErrors = kernelIssues?.some((issue) => issue.severity === 'error') ?? false;
      const status = cadSnapshot.value === 'error' || hasErrors ? 'error' : 'ready';

      return {
        success: true,
        status,
        kernelIssues: kernelIssues ?? [],
      };
    },
  };
}

function createBrowserGraphicsClient(
  resolveGraphicsForFile: ResolveGraphicsForFile,
  projectRef: ActorRefFrom<typeof projectMachine>,
  screenshotQuality: number,
): RpcGraphicsClient {
  return {
    async fetchGeometry({ targetFile }): Promise<FetchGeometryRpcResult> {
      const resolved = await ensureGeometryUnit(projectRef, targetFile);
      if (!resolved.ok) {
        return { success: false, errorCode: resolved.errorCode, message: resolved.message };
      }

      const { cadSnapshot } = resolved;
      const geometry = cadSnapshot.context.geometries.find((g) => g.format === 'gltf');

      if (geometry?.format !== 'gltf') {
        const issues = cadSnapshot.context.kernelIssues.get(targetFile) ?? [];
        const fileNotFoundIssue = issues.find(
          (issue) => issue.severity === 'error' && isFileNotFoundMessage(issue.message, targetFile),
        );

        if (fileNotFoundIssue) {
          return {
            success: false,
            errorCode: 'FILE_NOT_FOUND',
            message: `${targetFile} does not exist on disk. Create it with create_file before testing or fix the path.`,
          };
        }

        if (cadSnapshot.value === 'idle') {
          return {
            success: false,
            errorCode: 'NO_TOP_LEVEL_GEOMETRY',
            message: `${targetFile} compiled but produced no top-level geometry to render.`,
          };
        }

        return {
          success: false,
          errorCode: 'UNKNOWN',
          message: `No GLTF geometry available for ${targetFile}`,
        };
      }

      return { success: true, glb: geometry.content };
    },

    async captureScreenshot({ targetFile }): Promise<CaptureScreenshotRpcResult> {
      const graphicsRef = resolveGraphicsForFile(targetFile);
      if (!graphicsRef) {
        return {
          success: false,
          errorCode: 'UNKNOWN_GEOMETRY_UNIT',
          message: `No viewer panel currently displays ${targetFile}`,
        };
      }

      try {
        const source = await new Promise<string>((resolve, reject) => {
          const screenshotActor = createActor(screenshotRequestMachine, {
            input: { graphicsRef },
          }).start();

          screenshotActor.send({
            type: 'requestScreenshot',
            options: {
              output: {
                format: 'image/webp',
                quality: screenshotQuality,
                isPreview: true,
              },
              cameraAngles: [orthographicViews[0]!],
              aspectRatio: 1,
              maxResolution: 800,
              zoomLevel: 1.2,
            },
            onSuccess(dataUrls) {
              screenshotActor.stop();
              const capturedScreenshot = dataUrls[0];
              if (!capturedScreenshot) {
                reject(new Error('No screenshot data received'));
                return;
              }

              resolve(capturedScreenshot);
            },
            onError(errorMessage) {
              screenshotActor.stop();
              reject(new Error(errorMessage));
            },
          });
        });

        return {
          success: true,
          images: [{ view: 'current', dataUrl: source }],
        };
      } catch (error) {
        return {
          success: false,
          errorCode: error instanceof Error ? 'IO_ERROR' : 'UNKNOWN',
          message: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },

    async captureObservations({ targetFile }): Promise<CaptureObservationsRpcResult> {
      const graphicsRef = resolveGraphicsForFile(targetFile);
      if (!graphicsRef) {
        return {
          success: false,
          errorCode: 'UNKNOWN_GEOMETRY_UNIT',
          message: `No viewer panel currently displays ${targetFile}`,
        };
      }

      try {
        const viewAngles = orthographicViews.slice(0, 6);

        const compositeDataUrl = await new Promise<string>((resolve, reject) => {
          const screenshotActor = createActor(screenshotRequestMachine, {
            input: { graphicsRef },
          }).start();

          screenshotActor.send({
            type: 'requestCompositeScreenshot',
            options: {
              output: {
                format: 'image/webp',
                quality: screenshotQuality,
                isPreview: true,
              },
              cameraAngles: viewAngles,
              aspectRatio: 1,
              maxResolution: 800,
              zoomLevel: 1.2,
            },
            onSuccess(dataUrls) {
              screenshotActor.stop();
              const compositeUrl = dataUrls[0];
              if (!compositeUrl) {
                reject(new Error('No composite screenshot data received'));
                return;
              }

              resolve(compositeUrl);
            },
            onError(errorMessage) {
              screenshotActor.stop();
              reject(new Error(errorMessage));
            },
          });
        });

        return {
          success: true,
          observations: [
            {
              id: generatePrefixedId(idPrefix.observation),
              side: 'composite',
              src: compositeDataUrl,
            },
          ],
        };
      } catch (error) {
        return {
          success: false,
          errorCode: error instanceof Error ? 'IO_ERROR' : 'UNKNOWN',
          message: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  };
}

/**
 * Return type for createRpcHandlers
 */
export type RpcHandlers = {
  executeRpcCall: (rpcCall: RpcCallInput) => Promise<unknown>;
};

/**
 * Creates RPC handlers with the given browser dependencies.
 * Adapts browser-specific deps to abstract RpcDependencies, then delegates
 * to createRpcDispatcher from @taucad/chat/rpc.
 */
export function createRpcHandlers(deps: RpcHandlerDependencies): RpcHandlers {
  const { fileManager, resolveGraphicsForFile, projectRef, treeService, screenshotQuality } = deps;

  const rpcDeps: RpcDependencies = {
    fileSystem: createBrowserRpcFileSystem(fileManager, treeService),
    kernelClient: createBrowserRuntimeClient(projectRef),
    graphics: resolveGraphicsForFile
      ? createBrowserGraphicsClient(resolveGraphicsForFile, projectRef, screenshotQuality)
      : undefined,
  };

  const dispatcher = createRpcDispatcher(rpcDeps);

  return {
    async executeRpcCall(rpcCall: RpcCallInput): Promise<unknown> {
      return dispatcher.dispatch(rpcCall);
    },
  };
}
