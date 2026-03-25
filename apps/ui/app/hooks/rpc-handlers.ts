/**
 * RPC Handlers Browser Adapter
 *
 * Thin adapter that bridges browser-specific dependencies (fileManager, XState actors,
 * WebGL) to the transport-agnostic RPC handler interfaces in @taucad/chat/rpc.
 *
 * The core handler logic lives in libs/chat/src/rpc/handlers/. This module only
 * adapts browser-specific deps into the abstract RpcDependencies interface.
 */
import { createActor, waitFor } from 'xstate';
import type { ActorRefFrom } from 'xstate';
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
import { parentDirectory } from '@taucad/utils/path';
import { screenshotRequestMachine, orthographicViews } from '#machines/screenshot-request.machine.js';
import type { graphicsMachine } from '#machines/graphics.machine.js';
import type { projectMachine } from '#machines/project.machine.js';
import { decodeTextFile, encodeTextFile } from '#utils/filesystem.utils.js';

/** Source of file write operations */
type FileWriteSource = 'editor' | 'user' | 'machine';

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
  graphicsRef: ActorRefFrom<typeof graphicsMachine> | undefined;
  projectRef: ActorRefFrom<typeof projectMachine>;
  treeService: { getTreeSnapshot(): Map<string, FileEntry> } | undefined;
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
    ): Promise<Array<{ name: string; type: 'file' | 'directory'; size: number; modifiedAt?: string }>> {
      const entries: Array<{
        name: string;
        type: 'file' | 'directory';
        size: number;
        modifiedAt?: string;
      }> = [];

      const fileTree = treeService?.getTreeSnapshot() ?? new Map<string, FileEntry>();
      for (const [entryPath, entry] of fileTree.entries()) {
        const parentPath = entryPath.includes('/') ? parentDirectory(entryPath) : '';
        if (parentPath === path) {
          let modifiedAt: string | undefined;
          try {
            // oxlint-disable-next-line no-await-in-loop -- sequential stat calls
            const s = await fileManager.stat(entryPath);
            modifiedAt = new Date(s.mtimeMs).toISOString();
          } catch {
            // `stat` not available for this entry
          }
          entries.push({
            name: entry.name,
            type: entry.type === 'dir' ? 'directory' : 'file',
            size: entry.size,
            modifiedAt,
          });
        }
      }

      return entries;
    },
    async exists(path: string): Promise<boolean> {
      const fileTree = treeService?.getTreeSnapshot() ?? new Map<string, FileEntry>();
      return fileTree.has(path);
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

function createBrowserRuntimeClient(projectRef: ActorRefFrom<typeof projectMachine>): RpcRuntimeClient {
  return {
    async getKernelResult(targetFile: string): Promise<GetKernelResultRpcResult> {
      try {
        const projectSnapshot = projectRef.getSnapshot();
        const { compilationUnits } = projectSnapshot.context;
        let cadUnit = compilationUnits.get(targetFile);

        if (!cadUnit) {
          projectRef.send({
            type: 'createCompilationUnit',
            entryFile: targetFile,
          });
          const refreshed = projectRef.getSnapshot();
          cadUnit = refreshed.context.compilationUnits.get(targetFile);
        }

        if (!cadUnit) {
          return {
            success: false,
            errorCode: 'UNKNOWN',
            message: 'Failed to create compilation unit',
          };
        }

        const cadSnapshot = await waitFor(cadUnit, (state) => state.value === 'idle' || state.value === 'error');

        const kernelIssues = cadSnapshot.context.kernelIssues.get(targetFile);
        const hasErrors = kernelIssues?.some((issue) => issue.severity === 'error') ?? false;
        const status = cadSnapshot.value === 'error' || hasErrors ? 'error' : 'ready';

        return {
          success: true,
          status,
          kernelIssues: kernelIssues ?? [],
        };
      } catch (error) {
        return {
          success: false,
          errorCode: 'UNKNOWN',
          message: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  };
}

function createBrowserGraphicsClient(
  graphicsRef: ActorRefFrom<typeof graphicsMachine>,
  projectRef: ActorRefFrom<typeof projectMachine>,
  screenshotQuality: number,
): RpcGraphicsClient {
  return {
    async fetchGeometry(): Promise<FetchGeometryRpcResult> {
      try {
        const projectSnapshot = projectRef.getSnapshot();
        const { compilationUnits, mainEntryFile } = projectSnapshot.context;
        const mainUnit = compilationUnits.get(mainEntryFile);

        if (!mainUnit) {
          return {
            success: false,
            errorCode: 'UNKNOWN',
            message: 'No compilation unit found for main entry file',
          };
        }

        const cadSnapshot = mainUnit.getSnapshot();
        const geometry = cadSnapshot.context.geometries.find((g) => g.format === 'gltf');

        if (geometry?.format !== 'gltf') {
          return {
            success: false,
            errorCode: 'UNKNOWN',
            message: 'No GLTF geometry available',
          };
        }

        return { success: true, glb: geometry.content };
      } catch (error) {
        return {
          success: false,
          errorCode: 'UNKNOWN',
          message: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },

    async captureScreenshot(): Promise<CaptureScreenshotRpcResult> {
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

    async captureObservations(): Promise<CaptureObservationsRpcResult> {
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
  const { fileManager, graphicsRef, projectRef, treeService, screenshotQuality } = deps;

  const rpcDeps: RpcDependencies = {
    fileSystem: createBrowserRpcFileSystem(fileManager, treeService),
    kernelClient: createBrowserRuntimeClient(projectRef),
    graphics: graphicsRef ? createBrowserGraphicsClient(graphicsRef, projectRef, screenshotQuality) : undefined,
  };

  const dispatcher = createRpcDispatcher(rpcDeps);

  return {
    async executeRpcCall(rpcCall: RpcCallInput): Promise<unknown> {
      return dispatcher.dispatch(rpcCall);
    },
  };
}
