/**
 * RPC Handlers for Client-Side Operations
 *
 * This module contains the core logic for executing client-side RPC operations.
 * Each handler returns a discriminated result type with `success: true` for success
 * cases and `success: false` with error details for failures.
 *
 * The RPC handlers are used by the WebSocket handler to execute operations requested
 * by the backend on behalf of LLM tool calls.
 */
import { minimatch } from 'minimatch';
import { createActor, waitFor } from 'xstate';
import type { ActorRefFrom } from 'xstate';
import type {
  ReadFileRpcInput,
  ReadFileRpcResult,
  ListDirectoryRpcInput,
  ListDirectoryRpcResult,
  CreateFileRpcInput,
  CreateFileRpcResult,
  DeleteFileRpcInput,
  DeleteFileRpcResult,
  GrepRpcInput,
  GrepRpcResult,
  GlobSearchRpcInput,
  GlobSearchRpcResult,
  GetKernelResultRpcInput,
  GetKernelResultRpcResult,
  CaptureObservationsRpcInput,
  CaptureObservationsRpcResult,
  RpcClientErrorCode,
  RpcCall,
  Observation,
  ViewSide,
} from '@taucad/chat';
import { rpcName } from '@taucad/chat/constants';
import type { FileEntry } from '@taucad/types';
import { idPrefix } from '@taucad/types/constants';
import { generatePrefixedId } from '@taucad/utils/id';
import { screenshotRequestMachine, orthographicViews } from '#machines/screenshot-request.machine.js';
import type { graphicsMachine } from '#machines/graphics.machine.js';
import type { buildMachine } from '#machines/build.machine.js';
import { decodeTextFile, encodeTextFile } from '#utils/filesystem.utils.js';

/** Source of file write operations */
type FileWriteSource = 'editor' | 'user' | 'machine';

/**
 * Dependencies required for RPC execution.
 */
export type RpcHandlerDependencies = {
  /** File manager for read/write/delete operations (calls worker directly) */
  fileManager: {
    readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>>;
    writeFile: (path: string, data: Uint8Array<ArrayBuffer>, options: { source: FileWriteSource }) => Promise<void>;
    deleteFile: (path: string, options: { source: FileWriteSource }) => Promise<void>;
  };
  /** Graphics actor ref for screenshots (undefined when no view is mounted) */
  graphicsRef: ActorRefFrom<typeof graphicsMachine> | undefined;
  /** Build actor ref for compilation units */
  buildRef: ActorRefFrom<typeof buildMachine>;
  /** File tree for grep/glob operations */
  fileTree: Map<string, FileEntry>;
  /** Screenshot quality setting */
  screenshotQuality: number;
};

/**
 * RPC call input structure with toolCallId.
 * Extends RpcCall with the toolCallId from the original request.
 */
export type RpcCallInput = RpcCall & {
  toolCallId: string;
};

// Helper to extract error message safely
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}

// Helper to determine error code from error
function getErrorCode(error: unknown): RpcClientErrorCode {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('not found') || message.includes('enoent')) {
      return 'FILE_NOT_FOUND';
    }

    if (message.includes('permission') || message.includes('eacces')) {
      return 'PERMISSION_DENIED';
    }

    if (message.includes('parse') || message.includes('json')) {
      return 'PARSE_ERROR';
    }

    return 'IO_ERROR';
  }

  return 'UNKNOWN';
}

/**
 * Return type for createRpcHandlers
 */
export type RpcHandlers = {
  handleCaptureObservations: (input: CaptureObservationsRpcInput) => Promise<CaptureObservationsRpcResult>;
  handleReadFile: (input: ReadFileRpcInput) => Promise<ReadFileRpcResult>;
  handleListDirectory: (input: ListDirectoryRpcInput) => ListDirectoryRpcResult;
  handleCreateFile: (input: CreateFileRpcInput) => Promise<CreateFileRpcResult>;
  handleDeleteFile: (input: DeleteFileRpcInput) => Promise<DeleteFileRpcResult>;
  handleGrep: (input: GrepRpcInput) => Promise<GrepRpcResult>;
  handleGlobSearch: (input: GlobSearchRpcInput) => GlobSearchRpcResult;
  handleGetKernelResult: (input: GetKernelResultRpcInput) => Promise<GetKernelResultRpcResult>;
  executeRpcCall: (rpcCall: RpcCallInput) => Promise<unknown>;
};

/**
 * Creates RPC handlers with the given dependencies.
 * Returns an object with handler functions for each RPC operation.
 */
export function createRpcHandlers(deps: RpcHandlerDependencies): RpcHandlers {
  const { fileManager, graphicsRef, buildRef, fileTree, screenshotQuality } = deps;

  // Handler for capture observations RPC - captures screenshots from all orthographic views
  const handleCaptureObservations = async (
    _input: CaptureObservationsRpcInput,
  ): Promise<CaptureObservationsRpcResult> => {
    if (!graphicsRef) {
      return {
        success: false,
        errorCode: 'UNKNOWN',
        message: 'No graphics view is currently mounted for screenshots',
      };
    }

    try {
      const viewSides: ViewSide[] = ['front', 'back', 'right', 'left', 'top', 'bottom'];
      const viewAngles = orthographicViews.slice(0, 6);

      const observations: Observation[] = [];

      for (const [index, side] of viewSides.entries()) {
        const cameraAngle = viewAngles[index];
        if (!cameraAngle) {
          return {
            success: false,
            errorCode: 'UNKNOWN',
            message: `Missing camera angle for ${side} view`,
          };
        }

        // eslint-disable-next-line no-await-in-loop -- Sequential operation required
        const src = await new Promise<string>((resolve, reject) => {
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
              cameraAngles: [cameraAngle],
              aspectRatio: 1,
              maxResolution: 800,
              zoomLevel: 1.2,
            },
            onSuccess(dataUrls) {
              screenshotActor.stop();
              const capturedScreenshot = dataUrls[0];
              if (!capturedScreenshot) {
                reject(new Error(`No screenshot data received for ${side} view`));
                return;
              }

              resolve(capturedScreenshot);
            },
            onError(errorMessage) {
              console.error(`[CaptureObservations] ${side} view capture failed:`, errorMessage);
              screenshotActor.stop();
              reject(new Error(errorMessage));
            },
          });
        });

        const observation: Observation = {
          id: generatePrefixedId(idPrefix.observation),
          side,
          src,
        };

        observations.push(observation);
      }

      return { success: true, observations };
    } catch (error) {
      return {
        success: false,
        errorCode: getErrorCode(error),
        message: getErrorMessage(error),
      };
    }
  };

  // Handler for read file RPC
  // Returns raw content without line numbers - line numbers are added by the backend
  const handleReadFile = async (input: ReadFileRpcInput): Promise<ReadFileRpcResult> => {
    try {
      const fileContent = await fileManager.readFile(input.targetFile);
      const text = decodeTextFile(fileContent);
      const lines = text.split('\n');
      const totalLines = lines.length;

      const offset: number = input.offset ?? 1;
      const limit: number = input.limit ?? lines.length;
      const startIndex = Math.max(0, offset - 1);
      const endIndex = Math.min(lines.length, startIndex + limit);
      const selectedLines = lines.slice(startIndex, endIndex);

      // Return raw content - backend will add line numbers for LLM display
      const content = selectedLines.join('\n');

      return { success: true, content, totalLines, startLine: startIndex + 1 };
    } catch (error) {
      return {
        success: false,
        errorCode: getErrorCode(error),
        message: getErrorMessage(error),
      };
    }
  };

  // Handler for list directory RPC
  const handleListDirectory = (input: ListDirectoryRpcInput): ListDirectoryRpcResult => {
    try {
      const entries: Array<{ name: string; type: 'file' | 'dir'; size: number }> = [];

      for (const [entryPath, entry] of fileTree.entries()) {
        const parentPath = entryPath.includes('/') ? entryPath.slice(0, entryPath.lastIndexOf('/')) : '';
        if (parentPath === input.path) {
          entries.push({
            name: entry.name,
            type: entry.type,
            size: entry.size,
          });
        }
      }

      return { success: true, entries, path: input.path || '/' };
    } catch (error) {
      return {
        success: false,
        errorCode: getErrorCode(error),
        message: getErrorMessage(error),
      };
    }
  };

  // Handler for create file RPC
  const handleCreateFile = async (input: CreateFileRpcInput): Promise<CreateFileRpcResult> => {
    try {
      // Call fileManager.writeFile directly - this properly awaits the operation
      await fileManager.writeFile(input.targetFile, encodeTextFile(input.content), { source: 'machine' });

      const lineCount = input.content.split('\n').length;

      return {
        success: true,
        message: `File created: ${input.targetFile}`,
        diffStats: {
          linesAdded: lineCount,
          linesRemoved: 0,
          originalContent: '',
          modifiedContent: input.content,
        },
      };
    } catch (error) {
      return {
        success: false,
        errorCode: getErrorCode(error),
        message: getErrorMessage(error),
      };
    }
  };

  // Handler for delete file RPC
  const handleDeleteFile = async (input: DeleteFileRpcInput): Promise<DeleteFileRpcResult> => {
    try {
      // Call fileManager.deleteFile directly - this properly awaits the operation
      await fileManager.deleteFile(input.targetFile, { source: 'machine' });

      return { success: true, message: `File deleted: ${input.targetFile}` };
    } catch (error) {
      return {
        success: false,
        errorCode: getErrorCode(error),
        message: getErrorMessage(error),
      };
    }
  };

  // Handler for grep RPC
  const handleGrep = async (input: GrepRpcInput): Promise<GrepRpcResult> => {
    const matches: Array<{ file: string; line: number; content: string }> = [];
    const maxMatches = 100;

    try {
      const regex = new RegExp(input.pattern, input.caseSensitive === false ? 'gi' : 'g');

      const filesToSearch: string[] = [];
      for (const [path, entry] of fileTree.entries()) {
        if (entry.type !== 'file') {
          continue;
        }

        if (input.path && !path.startsWith(input.path)) {
          continue;
        }

        if (input.glob && !minimatch(path, input.glob, { matchBase: true })) {
          continue;
        }

        filesToSearch.push(path);
      }

      const searchPromises = filesToSearch.map(async (filePath) => {
        try {
          const content = await fileManager.readFile(filePath);
          const text = decodeTextFile(content);
          const lines = text.split('\n');
          const fileMatches: Array<{ file: string; line: number; content: string }> = [];

          for (const [lineIndex, line] of lines.entries()) {
            if (line && regex.test(line)) {
              fileMatches.push({
                file: filePath,
                line: lineIndex + 1,
                content: line,
              });
            }

            regex.lastIndex = 0;
          }

          return fileMatches;
        } catch {
          return [];
        }
      });

      const allFileMatches = await Promise.all(searchPromises);

      // Count total matches before truncating
      let totalMatches = 0;
      for (const fileMatches of allFileMatches) {
        totalMatches += fileMatches.length;
      }

      // Collect matches up to the limit
      for (const fileMatches of allFileMatches) {
        for (const match of fileMatches) {
          if (matches.length < maxMatches) {
            matches.push(match);
          }
        }
      }

      return {
        success: true,
        matches,
        totalMatches,
        truncated: totalMatches > maxMatches,
      };
    } catch (error) {
      return {
        success: false,
        errorCode: getErrorCode(error),
        message: getErrorMessage(error),
      };
    }
  };

  // Handler for glob search RPC
  const handleGlobSearch = (input: GlobSearchRpcInput): GlobSearchRpcResult => {
    const files: string[] = [];

    try {
      const basePath = input.path ?? '';

      for (const [path, entry] of fileTree.entries()) {
        if (entry.type !== 'file') {
          continue;
        }

        if (basePath && !path.startsWith(basePath)) {
          continue;
        }

        if (minimatch(path, input.pattern, { matchBase: true })) {
          files.push(path);
        }
      }

      return { success: true, files, totalFiles: files.length };
    } catch (error) {
      return {
        success: false,
        errorCode: getErrorCode(error),
        message: getErrorMessage(error),
      };
    }
  };

  // Handler for get kernel result RPC
  // Uses the compilation unit for the target file only. Creates on-demand if not found.
  const handleGetKernelResult = async (input: GetKernelResultRpcInput): Promise<GetKernelResultRpcResult> => {
    try {
      // 1. Find the compilation unit for the target file
      const buildSnapshot = buildRef.getSnapshot();
      const { compilationUnits } = buildSnapshot.context;
      let cadUnit = compilationUnits.get(input.targetFile);

      // 2. Create on-demand headless compilation if not found
      if (!cadUnit) {
        buildRef.send({ type: 'createCompilationUnit', entryFile: input.targetFile });
        // Re-read after creation (synchronous assign in the machine)
        const refreshed = buildRef.getSnapshot();
        cadUnit = refreshed.context.compilationUnits.get(input.targetFile);
      }

      if (!cadUnit) {
        return { success: false, errorCode: 'UNKNOWN', message: 'Failed to create compilation unit' };
      }

      // 3. Wait for compilation to complete
      const cadSnapshot = await waitFor(cadUnit, (state) => state.value === 'ready' || state.value === 'error');

      // 4. Return issues for the target file specifically
      const kernelIssues = cadSnapshot.context.kernelIssues.get(input.targetFile);
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
        errorCode: getErrorCode(error),
        message: getErrorMessage(error),
      };
    }
  };

  /**
   * Execute an RPC call and return the result.
   * Uses discriminated union narrowing - TypeScript automatically narrows
   * `rpcCall.args` to the correct type based on `rpcCall.rpcName`.
   */
  const executeRpcCall = async (rpcCall: RpcCallInput): Promise<unknown> => {
    switch (rpcCall.rpcName) {
      case rpcName.captureObservations: {
        return handleCaptureObservations(rpcCall.args);
      }

      case rpcName.readFile: {
        return handleReadFile(rpcCall.args);
      }

      case rpcName.listDirectory: {
        return handleListDirectory(rpcCall.args);
      }

      case rpcName.createFile: {
        return handleCreateFile(rpcCall.args);
      }

      case rpcName.deleteFile: {
        return handleDeleteFile(rpcCall.args);
      }

      case rpcName.grep: {
        return handleGrep(rpcCall.args);
      }

      case rpcName.globSearch: {
        return handleGlobSearch(rpcCall.args);
      }

      case rpcName.getKernelResult: {
        return handleGetKernelResult(rpcCall.args);
      }
    }
  };

  return {
    handleCaptureObservations,
    handleReadFile,
    handleListDirectory,
    handleCreateFile,
    handleDeleteFile,
    handleGrep,
    handleGlobSearch,
    handleGetKernelResult,
    executeRpcCall,
  };
}
