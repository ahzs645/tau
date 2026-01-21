/**
 * Tool Handlers for Client-Side Tool Execution
 *
 * This module contains the core logic for executing client-side tools.
 * It can be used by both the AI SDK onToolCall callback and the WebSocket tool handler.
 */
import { minimatch } from 'minimatch';
import { createActor, waitFor } from 'xstate';
import type { ActorRefFrom } from 'xstate';
import type {
  ReadFileInput,
  ReadFileOutput,
  ListDirectoryInput,
  ListDirectoryOutput,
  CreateFileInput,
  CreateFileOutput,
  DeleteFileInput,
  DeleteFileOutput,
  GrepInput,
  GrepOutput,
  GlobSearchInput,
  GlobSearchOutput,
  GetKernelResultInput,
  GetKernelResultOutput,
  CaptureObservationsOutput,
  Observation,
  ViewSide,
  ClientToolName,
} from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import type { FileEntry } from '@taucad/types';
import { idPrefix } from '@taucad/types/constants';
import { generatePrefixedId } from '@taucad/utils/id';
import { screenshotRequestMachine, orthographicViews } from '#machines/screenshot-request.machine.js';
import type { graphicsMachine } from '#machines/graphics.machine.js';
import type { cadMachine } from '#machines/cad.machine.js';
import { decodeTextFile, encodeTextFile } from '#utils/filesystem.utils.js';

/** Source of file write operations */
type FileWriteSource = 'editor' | 'user' | 'machine';

/**
 * Dependencies required for tool execution.
 */
export type ToolHandlerDependencies = {
  /** File manager for read/write/delete operations (calls worker directly) */
  fileManager: {
    readFile: (path: string) => Promise<Uint8Array>;
    writeFile: (path: string, data: Uint8Array, options: { source: FileWriteSource }) => Promise<void>;
    deleteFile: (path: string, options: { source: FileWriteSource }) => Promise<void>;
  };
  /** Graphics actor ref for screenshots */
  graphicsRef: ActorRefFrom<typeof graphicsMachine>;
  /** CAD actor ref for kernel status */
  cadRef: ActorRefFrom<typeof cadMachine>;
  /** File tree for grep/glob operations */
  fileTree: Map<string, FileEntry>;
  /** Screenshot quality setting */
  screenshotQuality: number;
};

/**
 * Tool call input structure
 */
export type ToolCallInput<T = unknown> = {
  toolCallId: string;
  toolName: ClientToolName;
  args: T;
};

// Helper to extract error message safely
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}

/**
 * Return type for createToolHandlers
 */
export type ToolHandlers = {
  handleCaptureObservations: () => Promise<CaptureObservationsOutput>;
  handleReadFile: (input: ReadFileInput) => Promise<ReadFileOutput>;
  handleListDirectory: (input: ListDirectoryInput) => ListDirectoryOutput;
  handleCreateFile: (input: CreateFileInput) => Promise<CreateFileOutput>;
  handleDeleteFile: (input: DeleteFileInput) => Promise<DeleteFileOutput>;
  handleGrep: (input: GrepInput) => Promise<GrepOutput>;
  handleGlobSearch: (input: GlobSearchInput) => GlobSearchOutput;
  handleGetKernelResult: (input: GetKernelResultInput) => Promise<GetKernelResultOutput>;
  executeToolCall: (toolCall: ToolCallInput) => Promise<unknown>;
};

/**
 * Creates tool handlers with the given dependencies.
 * Returns an object with handler functions for each tool.
 */
export function createToolHandlers(deps: ToolHandlerDependencies): ToolHandlers {
  const { fileManager, graphicsRef, cadRef, fileTree, screenshotQuality } = deps;

  // Handler for capture observations tool - captures screenshots from all orthographic views
  const handleCaptureObservations = async (): Promise<CaptureObservationsOutput> => {
    const viewSides: ViewSide[] = ['front', 'back', 'right', 'left', 'top', 'bottom'];
    const viewAngles = orthographicViews.slice(0, 6);

    const observations: Observation[] = [];

    for (const [index, side] of viewSides.entries()) {
      const cameraAngle = viewAngles[index];
      if (!cameraAngle) {
        throw new Error(`Missing camera angle for ${side} view`);
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

    return { observations };
  };

  // Handler for read file tool
  // Returns raw content without line numbers - line numbers are added by the backend
  const handleReadFile = async (input: ReadFileInput): Promise<ReadFileOutput> => {
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

      return { content, totalLines, startLine: startIndex + 1 };
    } catch (error) {
      return {
        content: `Error reading file: ${getErrorMessage(error)}`,
        totalLines: 0,
      };
    }
  };

  // Handler for list directory tool
  const handleListDirectory = (input: ListDirectoryInput): ListDirectoryOutput => {
    const entries: ListDirectoryOutput['entries'] = [];

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

    return { entries, path: input.path || '/' };
  };

  // Handler for create file tool
  const handleCreateFile = async (input: CreateFileInput): Promise<CreateFileOutput> => {
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
        message: `Failed to create file: ${getErrorMessage(error)}`,
        diffStats: {
          linesAdded: 0,
          linesRemoved: 0,
          originalContent: '',
          modifiedContent: '',
        },
      };
    }
  };

  // Handler for delete file tool
  const handleDeleteFile = async (input: DeleteFileInput): Promise<DeleteFileOutput> => {
    try {
      // Call fileManager.deleteFile directly - this properly awaits the operation
      await fileManager.deleteFile(input.targetFile, { source: 'machine' });

      return { success: true, message: `File deleted: ${input.targetFile}` };
    } catch (error) {
      return { success: false, message: `Failed to delete file: ${getErrorMessage(error)}` };
    }
  };

  // Handler for grep tool
  const handleGrep = async (input: GrepInput): Promise<GrepOutput> => {
    const matches: GrepOutput['matches'] = [];
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
          const fileMatches: GrepOutput['matches'] = [];

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
        matches,
        totalMatches,
        truncated: totalMatches > maxMatches,
      };
    } catch {
      return {
        matches: [],
        totalMatches: 0,
        truncated: false,
      };
    }
  };

  // Handler for glob search tool
  const handleGlobSearch = (input: GlobSearchInput): GlobSearchOutput => {
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

      return { files, totalFiles: files.length };
    } catch {
      return { files: [], totalFiles: 0 };
    }
  };

  // Handler for get kernel result tool
  const handleGetKernelResult = async (input: GetKernelResultInput): Promise<GetKernelResultOutput> => {
    try {
      const cadSnapshot = await waitFor(cadRef, (state) => state.value === 'ready' || state.value === 'error');

      const kernelIssues = cadSnapshot.context.kernelIssues.get(input.targetFile);

      const hasErrors = kernelIssues?.some((issue) => issue.severity === 'error') ?? false;
      const status = cadSnapshot.value === 'error' || hasErrors ? 'error' : 'ready';

      return {
        status,
        kernelIssues: kernelIssues ?? [],
      };
    } catch {
      return {
        status: 'error',
        kernelIssues: [],
      };
    }
  };

  /**
   * Execute a tool call and return the result.
   */
  const executeToolCall = async (toolCall: ToolCallInput): Promise<unknown> => {
    const { toolName: currentToolName, args } = toolCall;

    switch (currentToolName) {
      case toolName.captureObservations: {
        return handleCaptureObservations();
      }

      case toolName.readFile: {
        return handleReadFile(args as ReadFileInput);
      }

      case toolName.listDirectory: {
        return handleListDirectory(args as ListDirectoryInput);
      }

      case toolName.createFile: {
        return handleCreateFile(args as CreateFileInput);
      }

      case toolName.deleteFile: {
        return handleDeleteFile(args as DeleteFileInput);
      }

      case toolName.grep: {
        return handleGrep(args as GrepInput);
      }

      case toolName.globSearch: {
        return handleGlobSearch(args as GlobSearchInput);
      }

      case toolName.getKernelResult: {
        return handleGetKernelResult(args as GetKernelResultInput);
      }

      default: {
        throw new Error(`Unknown tool: ${String(currentToolName)}`);
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
    executeToolCall,
  };
}
