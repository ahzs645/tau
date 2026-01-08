import { minimatch } from 'minimatch';
import { useCallback } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import type { useChat } from '@ai-sdk/react';
import type { ChatOnToolCallCallback } from 'ai';
import { createActor, waitFor } from 'xstate';
import type {
  EditFileInput,
  EditFileOutput,
  ImageAnalysisInput,
  ImageAnalysisOutput,
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
  ReasoningOutput,
  MyUIMessage,
  MyTools,
  Observation,
  ViewSide,
} from '@taucad/chat';
import { toolName, clientToolNames } from '@taucad/chat/constants';
import type { ClientToolName } from '@taucad/chat/constants';
import { idPrefix } from '@taucad/types/constants';
import { generatePrefixedId } from '@taucad/utils/id';
import { fileEditMachine } from '#machines/file-edit.machine.js';
import { screenshotRequestMachine, orthographicViews } from '#machines/screenshot-request.machine.js';
import { imageAnalysisMachine, buildImageAnalysisOutput } from '#machines/image-analysis.machine.js';
import { decodeTextFile, encodeTextFile } from '#utils/filesystem.utils.js';
import { useBuild } from '#hooks/use-build.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { useImageQuality } from '#hooks/use-image-quality.js';

/**
 * Union of all possible tool outputs, derived from clientToolNames.
 * This ensures the type stays in sync with the list of client-side tools.
 */
type ToolOutputUnion = {
  [K in ClientToolName]: K extends keyof MyTools ? (MyTools[K] extends { output: infer O } ? O : never) : never;
}[ClientToolName];

// Type for addToolOutput function from useChat
type AddToolOutputFn = ReturnType<typeof useChat<MyUIMessage>>['addToolOutput'];

// Dependencies passed to createOnToolCall for extensibility
export type OnToolCallDependencies = {
  addToolOutput: AddToolOutputFn;
};

// Factory function type that creates the onToolCall callback
export type CreateOnToolCallFn = (dependencies: OnToolCallDependencies) => ChatOnToolCallCallback<MyUIMessage>;

type UseChatToolsReturn = {
  readonly createOnToolCall: CreateOnToolCallFn;
};

// Helper to extract error message safely
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}

export function useChatTools(): UseChatToolsReturn {
  const { graphicsRef: graphicsActor, cadRef: cadActor, getMainFilename, buildId } = useBuild();
  const fileManager = useFileManager();
  const { fileManagerRef } = fileManager;
  const fileEditRef = useActorRef(fileEditMachine);

  // Get file tree for grep and glob operations
  const fileTree = useSelector(fileManagerRef, (state) => state.context.fileTree);

  // Get screenshot quality from user settings
  const { quality: screenshotQuality } = useImageQuality();

  const createOnToolCall: CreateOnToolCallFn = useCallback(
    (dependencies) => {
      // Helper to resolve paths relative to build root
      const resolvePath = (targetFile: string): string => {
        // If the path is already absolute or starts with the build prefix, use as-is
        if (targetFile.startsWith('/') || targetFile.startsWith(`builds/${buildId}`)) {
          return targetFile;
        }

        // Otherwise, return as-is (relative to project root)
        return targetFile;
      };

      // Handler for file edit tool
      const handleEditFile = async (toolCall: {
        toolCallId: string;
        input: EditFileInput;
      }): Promise<EditFileOutput> => {
        const { input } = toolCall;

        // Use the targetFile from input, falling back to main file for backwards compatibility
        const mainFilePath = await getMainFilename();
        const resolvedPath = input.targetFile ? resolvePath(input.targetFile) : mainFilePath;

        let currentCode: Uint8Array;
        try {
          currentCode = await fileManager.readFile(resolvedPath);
        } catch {
          // File doesn't exist yet, start with empty content
          currentCode = new Uint8Array();
        }

        const originalContent = decodeTextFile(currentCode);

        fileEditRef.start();
        fileEditRef.send({
          type: 'applyEdit',
          request: {
            targetFile: resolvedPath,
            originalContent,
            codeEdit: input.codeEdit,
          },
        });

        // Wait for file edit to complete
        const fileEditSnapshot = await waitFor(
          fileEditRef,
          (state) => state.matches('success') || state.matches('error'),
        );

        const { result } = fileEditSnapshot.context;

        if (!result) {
          throw new Error('No result received from file edit service');
        }

        await fileManager.writeFile(resolvedPath, encodeTextFile(result.editedContent), { source: 'external' });

        // Return with diffStats for UI display
        const linesAdded = result.diffStats?.linesAdded;
        const linesRemoved = result.diffStats?.linesRemoved;
        return {
          success: result.success,
          diffStats: {
            linesAdded: typeof linesAdded === 'number' ? linesAdded : 0,
            linesRemoved: typeof linesRemoved === 'number' ? linesRemoved : 0,
            originalContent,
            modifiedContent: result.editedContent,
          },
        };
      };

      // Handler for image analysis tool
      const handleImageAnalysis = async (toolCall: {
        toolCallId: string;
        input: ImageAnalysisInput;
      }): Promise<ImageAnalysisOutput> => {
        const { input } = toolCall;
        const { requirements } = input;

        // 1. Capture 6 individual screenshots (one per orthographic view)
        const viewSides: ViewSide[] = ['front', 'back', 'right', 'left', 'top', 'bottom'];
        const viewAngles = orthographicViews.slice(0, 6);

        // Capture screenshots sequentially because the graphics machine
        // can only handle one screenshot request at a time
        const observations: Observation[] = [];

        for (const [index, side] of viewSides.entries()) {
          const cameraAngle = viewAngles[index];
          if (!cameraAngle) {
            throw new Error(`Missing camera angle for ${side} view`);
          }

          // eslint-disable-next-line no-await-in-loop -- This is a sequential operation.
          const src = await new Promise<string>((resolve, reject) => {
            const screenshotActor = createActor(screenshotRequestMachine, {
              input: { graphicsRef: graphicsActor },
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
                aspectRatio: 1, // Square images
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
                console.error(`[ImageAnalysis] ${side} view capture failed:`, errorMessage);
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

        // 2. Analyze all observations using the API via the image analysis machine
        const analysisActor = createActor(imageAnalysisMachine, {
          input: { observations, requirements },
        }).start();

        // Wait for the analysis to complete
        const snapshot = await waitFor(analysisActor, (state) => state.matches('success') || state.matches('error'));

        analysisActor.stop();

        if (snapshot.matches('error')) {
          console.error('[ImageAnalysis] Analysis failed with error:', snapshot.context.error);
          // Return observations with empty results on error
          return {
            observations,
            observationResults: [],
            aggregatedResults: [],
            evaluationCriteria: {
              totalObservations: observations.length,
            },
          };
        }

        return buildImageAnalysisOutput(snapshot.context);
      };

      // Handler for read file tool
      const handleReadFile = async (toolCall: {
        toolCallId: string;
        input: ReadFileInput;
      }): Promise<ReadFileOutput> => {
        const { input } = toolCall;
        const resolvedPath = resolvePath(input.targetFile);

        try {
          const fileContent = await fileManager.readFile(resolvedPath);
          const text = decodeTextFile(fileContent);
          const lines = text.split('\n');
          const totalLines = lines.length;

          // Apply offset and limit
          const offset: number = input.offset ?? 1;
          const limit: number = input.limit ?? lines.length;
          const startIndex = Math.max(0, offset - 1);
          const endIndex = Math.min(lines.length, startIndex + limit);
          const selectedLines = lines.slice(startIndex, endIndex);

          // Format with line numbers
          const content = selectedLines
            .map((line, index) => `${String(startIndex + index + 1).padStart(6)}|${line}`)
            .join('\n');

          return { content, totalLines };
        } catch (error) {
          return {
            content: `Error reading file: ${getErrorMessage(error)}`,
            totalLines: 0,
          };
        }
      };

      // Handler for list directory tool
      const handleListDirectory = (toolCall: {
        toolCallId: string;
        input: ListDirectoryInput;
      }): ListDirectoryOutput => {
        const { input } = toolCall;
        const resolvedPath = input.path === '' ? '' : resolvePath(input.path);

        const entries: ListDirectoryOutput['entries'] = [];

        // Get entries from file tree that match the path
        for (const [entryPath, entry] of fileTree.entries()) {
          // Check if entry is a direct child of the requested path
          const parentPath = entryPath.includes('/') ? entryPath.slice(0, entryPath.lastIndexOf('/')) : '';
          if (parentPath === resolvedPath) {
            entries.push({
              name: entry.name,
              type: entry.type,
              size: entry.size,
            });
          }
        }

        return { entries, path: resolvedPath || '/' };
      };

      // Handler for create file tool
      const handleCreateFile = async (toolCall: {
        toolCallId: string;
        input: CreateFileInput;
      }): Promise<CreateFileOutput> => {
        const { input } = toolCall;
        const resolvedPath = resolvePath(input.targetFile);

        // Wait for file manager to be in a state that can accept writeFile events
        // This ensures the event won't be dropped if machine is busy with another operation
        await waitFor(fileManagerRef, (state) => state.matches('ready') || state.matches('error'));

        // Send write file event - use 'file-tree' source for proper tracking
        fileManagerRef.send({
          type: 'writeFile',
          path: resolvedPath,
          data: encodeTextFile(input.content),
          source: 'external',
        });

        // Calculate line count for new file (all lines are additions)
        const lineCount = input.content.split('\n').length;

        // Return with diffStats for UI display
        return {
          success: true,
          message: `File created: ${resolvedPath}`,
          diffStats: {
            linesAdded: lineCount,
            linesRemoved: 0,
            originalContent: '',
            modifiedContent: input.content,
          },
        };
      };

      // Handler for delete file tool
      const handleDeleteFile = async (toolCall: {
        toolCallId: string;
        input: DeleteFileInput;
      }): Promise<DeleteFileOutput> => {
        const { input } = toolCall;
        const resolvedPath = resolvePath(input.targetFile);

        // Wait for file manager to be in a state that can accept deleteFile events
        await waitFor(fileManagerRef, (state) => state.matches('ready') || state.matches('error'));

        // Send delete event to file manager machine
        fileManagerRef.send({ type: 'deleteFile', path: resolvedPath, source: 'external' });

        // Return immediately without waiting for completion
        // LLM should use get_kernel_result to verify changes
        return { success: true, message: `File deleted: ${resolvedPath}` };
      };

      // Handler for grep tool
      const handleGrep = async (toolCall: { toolCallId: string; input: GrepInput }): Promise<GrepOutput> => {
        const { input } = toolCall;
        const matches: GrepOutput['matches'] = [];
        const maxMatches = 100;

        try {
          const regex = new RegExp(input.pattern, input.caseSensitive === false ? 'gi' : 'g');

          // Filter files to search
          const filesToSearch: string[] = [];
          for (const [path, entry] of fileTree.entries()) {
            if (entry.type !== 'file') {
              continue;
            }

            // Check path filter
            if (input.path && !path.startsWith(resolvePath(input.path))) {
              continue;
            }

            // Check glob filter
            if (input.glob && !minimatch(path, input.glob, { matchBase: true })) {
              continue;
            }

            filesToSearch.push(path);
          }

          // Search each file (using Promise.all for parallel reads)
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

                // Reset regex lastIndex for global flag
                regex.lastIndex = 0;
              }

              return fileMatches;
            } catch {
              return [];
            }
          });

          const allFileMatches = await Promise.all(searchPromises);
          for (const fileMatches of allFileMatches) {
            for (const match of fileMatches) {
              if (matches.length < maxMatches) {
                matches.push(match);
              }
            }
          }

          return {
            matches,
            totalMatches: matches.length,
            truncated: matches.length >= maxMatches,
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
      const handleGlobSearch = (toolCall: { toolCallId: string; input: GlobSearchInput }): GlobSearchOutput => {
        const { input } = toolCall;
        const files: string[] = [];

        try {
          const basePath = input.path ? resolvePath(input.path) : '';

          for (const [path, entry] of fileTree.entries()) {
            if (entry.type !== 'file') {
              continue;
            }

            // Check if path is under base path
            if (basePath && !path.startsWith(basePath)) {
              continue;
            }

            // Match against glob pattern
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
      const handleGetKernelResult = async (toolCall: {
        toolCallId: string;
        input: GetKernelResultInput;
      }): Promise<GetKernelResultOutput> => {
        const { input } = toolCall;

        try {
          // Use target file if provided, otherwise fall back to main file
          const mainFilePath = await getMainFilename();
          const resolvedPath = input.targetFile ? resolvePath(input.targetFile) : mainFilePath;

          // Wait for CAD processing to complete
          const cadSnapshot = await waitFor(cadActor, (state) => state.value === 'ready' || state.value === 'error');

          // Get the kernel errors for the specified file
          const kernelErrors = cadSnapshot.context.kernelErrors.get(resolvedPath);

          const status = cadSnapshot.value === 'error' || (kernelErrors && kernelErrors.length > 0) ? 'error' : 'ready';

          return {
            status,
            kernelErrors: kernelErrors ?? [],
            message:
              status === 'ready' ? 'Kernel compilation successful' : `Found ${kernelErrors?.length ?? 0} error(s)`,
          };
        } catch (error) {
          return {
            status: 'error',
            kernelErrors: [],
            message: `Failed to get kernel result: ${getErrorMessage(error)}`,
          };
        }
      };

      // Handler for reasoning tool
      const handleReasoning = (): ReasoningOutput => {
        // Reasoning tool is primarily for display - the LLM's thinking is captured in the input
        // We simply acknowledge it and return the duration
        const startTime = Date.now();
        return {
          acknowledged: true,
          durationMs: Date.now() - startTime,
        };
      };

      // Main tool call handler - executes handlers and calls addToolOutput for each
      // AI SDK collects all outputs and sends them together via sendAutomaticallyWhen
      return async ({ toolCall }): Promise<void> => {
        const { toolCallId, toolName: currentToolName } = toolCall;
        const { addToolOutput } = dependencies;

        // Helper to check if a tool is a client-side tool (uses interrupt)
        // Server-only tools (transfers, web search) are NOT handled here
        const isClientTool = (name: string): name is ClientToolName => {
          return clientToolNames.includes(name as ClientToolName);
        };

        // Skip server-only tools (transfers, web search, etc.)
        if (!isClientTool(currentToolName)) {
          return;
        }

        // Skip dynamic tools (input type is unknown)
        if ('dynamic' in toolCall && toolCall.dynamic) {
          return;
        }

        // Execute handler and get the result
        let output: ToolOutputUnion;

        switch (currentToolName) {
          case toolName.editFile: {
            output = await handleEditFile(toolCall);
            break;
          }

          case toolName.imageAnalysis: {
            output = await handleImageAnalysis(toolCall);
            break;
          }

          case toolName.readFile: {
            output = await handleReadFile(toolCall);
            break;
          }

          case toolName.listDirectory: {
            output = handleListDirectory(toolCall);
            break;
          }

          case toolName.createFile: {
            output = await handleCreateFile(toolCall);
            break;
          }

          case toolName.deleteFile: {
            output = await handleDeleteFile(toolCall);
            break;
          }

          case toolName.grep: {
            output = await handleGrep(toolCall);
            break;
          }

          case toolName.globSearch: {
            output = handleGlobSearch(toolCall);
            break;
          }

          case toolName.getKernelResult: {
            output = await handleGetKernelResult(toolCall);
            break;
          }

          case toolName.reasoning: {
            output = handleReasoning();
            break;
          }

          default: {
            // All recognized tools are handled above
            return;
          }
        }

        // Call addToolOutput to register the result with AI SDK
        // AI SDK will batch all outputs and send via sendAutomaticallyWhen
        void addToolOutput({
          tool: currentToolName,
          toolCallId,
          output,
        });
      };
    },
    [
      buildId,
      cadActor,
      fileEditRef,
      fileManager,
      fileManagerRef,
      fileTree,
      getMainFilename,
      graphicsActor,
      screenshotQuality,
    ],
  );

  return {
    createOnToolCall,
  };
}
