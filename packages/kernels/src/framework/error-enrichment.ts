/**
 * Error Enrichment Utilities
 *
 * Standalone functions for parsing stack traces, classifying frames,
 * resolving source maps, and deriving error locations.
 *
 * Extracted from JavaScriptWorker to be usable by both legacy workers
 * and new defineKernel modules.
 */

import { SourceMapConsumer } from 'source-map-js';
import type { KernelStackFrame, FrameContext, ErrorLocation } from '#types/kernel.types.js';

// =============================================================================
// Stack Trace Parsing
// =============================================================================

type LibraryPattern = { pattern: string; moduleName: string };

/**
 * Parse an error's stack trace into structured stack frames.
 *
 * @param error - the thrown value (only Error instances with `.stack` are processed)
 * @param options - optional configuration for frame classification, source mapping, and path resolution
 * @returns array of parsed stack frames, source-mapped when a source map is provided
 */
export function parseStackTrace(
  error: unknown,
  options?: {
    classifyFrame?: (fileName: string) => FrameContext;
    sourceMap?: string;
    resolveSourcePath?: (sourcePath: string) => string;
    lastEntryName?: string;
  },
): KernelStackFrame[] {
  if (!(error instanceof Error) || !error.stack) {
    return [];
  }

  const classifier = options?.classifyFrame ?? defaultClassifyFrame;
  const frames: KernelStackFrame[] = [];
  const lines = error.stack.split('\n');

  for (const line of lines) {
    // Chrome: "    at functionName (file:line:column)"
    // Firefox: "functionName@file:line:column"
    const chromeMatch = /^\s*at\s+(?:(.+?)\s+)?\(?(.+):(\d+):(\d+)\)?$/.exec(line);
    const firefoxMatch = /^(.*)@(.+):(\d+):(\d+)$/.exec(line);

    const match = chromeMatch ?? firefoxMatch;
    if (match) {
      const [, rawFunctionName, fileName, lineNumber, columnNumber] = match;
      const functionName = rawFunctionName?.replace(/^Proxy\./, '') ?? '<anonymous>';

      frames.push({
        functionName,
        fileName: fileName ?? '',
        lineNumber: Number.parseInt(lineNumber ?? '0', 10),
        columnNumber: Number.parseInt(columnNumber ?? '0', 10),
        context: classifier(fileName ?? ''),
      });
    }
  }

  return applySourceMapToFrames({
    frames,
    sourceMapJson: options?.sourceMap,
    resolveSourcePathFn: options?.resolveSourcePath,
    lastEntryName: options?.lastEntryName,
  });
}

// =============================================================================
// Frame Classification
// =============================================================================

/**
 * Default frame classifier.
 *
 * - blob: URLs → user code (bundled)
 * - node:, <, wasm: → runtime
 * - node_modules/, data:, /kernel/ → framework
 * - Everything else → user
 *
 * @param fileName - the source file URL or path to classify
 * @returns the frame context category for the given file
 */
function defaultClassifyFrame(fileName: string): FrameContext {
  if (fileName.startsWith('blob:')) {
    return 'user';
  }

  if (fileName.startsWith('node:') || fileName.startsWith('<') || fileName.startsWith('wasm:')) {
    return 'runtime';
  }

  if (
    fileName.includes('/node_modules/') ||
    fileName.startsWith('data:') ||
    fileName.includes('/kernel/') ||
    fileName.includes('/kernels/')
  ) {
    return 'framework';
  }

  return 'user';
}

/**
 * Create a frame classifier that recognises specific library patterns.
 *
 * @param libraryPatterns - patterns to match against file names for library detection
 * @returns classifier function that assigns a {@link FrameContext} to a given file name
 */
export function createFrameClassifier(libraryPatterns: LibraryPattern[]): (fileName: string) => FrameContext {
  return (fileName: string): FrameContext => {
    if (fileName.startsWith('blob:')) {
      return 'user';
    }

    if (libraryPatterns.some((library) => fileName.includes(library.pattern))) {
      return 'library';
    }

    if (fileName.startsWith('node:') || fileName.startsWith('<') || fileName.startsWith('wasm:')) {
      return 'runtime';
    }

    if (
      fileName.includes('/node_modules/') ||
      fileName.startsWith('data:') ||
      fileName.includes('/kernel/') ||
      fileName.includes('/kernels/')
    ) {
      return 'framework';
    }

    return 'user';
  };
}

// =============================================================================
// Source Map Resolution
// =============================================================================

/**
 * Resolve a source map path to a project-relative path.
 * esbuild source maps contain paths prefixed with the namespace (e.g., `zenfs:main.ts`).
 *
 * @param sourcePath - raw source path from the source map
 * @param projectPath - optional project root to strip from the path
 * @returns cleaned path relative to the project root
 */
export function resolveSourcePath(sourcePath: string, projectPath?: string): string {
  const zenfsPrefix = 'zenfs:';
  const cleanPath = sourcePath.startsWith(zenfsPrefix) ? sourcePath.slice(zenfsPrefix.length) : sourcePath;

  if (projectPath && cleanPath.startsWith(projectPath)) {
    const relative = cleanPath.slice(projectPath.length);
    return relative.startsWith('/') ? relative.slice(1) : relative;
  }

  if (!cleanPath.startsWith('/')) {
    return cleanPath;
  }

  return cleanPath.split('/').pop() ?? cleanPath;
}

/**
 * Apply source map resolution to parsed stack frames.
 * Maps generated (post-bundle) positions in blob:/data: URLs back to
 * original source file paths and line/column numbers.
 *
 * @param options - source map resolution configuration with frames, source map JSON, and path resolver
 * @returns stack frames with resolved original source positions
 */
function applySourceMapToFrames(options: {
  frames: KernelStackFrame[];
  sourceMapJson?: string;
  resolveSourcePathFn?: (sourcePath: string) => string;
  lastEntryName?: string;
}): KernelStackFrame[] {
  const { frames, sourceMapJson, resolveSourcePathFn, lastEntryName } = options;
  if (!sourceMapJson) {
    return frames;
  }

  try {
    const rawMap: unknown = JSON.parse(sourceMapJson);
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- source-map-js accepts parsed JSON
    const consumer = new SourceMapConsumer(rawMap as any);
    const resolver = resolveSourcePathFn ?? ((s: string) => resolveSourcePath(s));

    return frames.map((frame) => {
      const name = frame.fileName ?? '';
      const isBundledFrame = name.startsWith('blob:') || name.startsWith('data:') || name === lastEntryName;

      if (!isBundledFrame || !frame.lineNumber) {
        return frame;
      }

      const original = consumer.originalPositionFor({
        line: frame.lineNumber,
        column: (frame.columnNumber ?? 1) - 1,
      });

      if (!original.source) {
        return frame;
      }

      const fileName = resolver(original.source);

      return {
        ...frame,
        fileName,
        // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- source-map-js returns null at runtime despite types saying number
        lineNumber: original.line ?? frame.lineNumber,
        // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- source-map-js returns null at runtime despite types saying number
        columnNumber: (original.column ?? 0) + 1,
        functionName: original.name ?? frame.functionName,
        context: 'user',
      };
    });
  } catch {
    return frames;
  }
}

// =============================================================================
// Library Source Map Resolution
// =============================================================================

/**
 * Resolve a library source map path to a clean display path.
 * E.g., '../src/sketches/Sketch.ts' → 'replicad/src/sketches/Sketch.ts'
 *
 * @param moduleName - npm package name used as the display prefix
 * @param rawSource - raw source path from the library's source map
 * @returns cleaned display path prefixed with the module name
 */
export function resolveLibrarySourcePath(moduleName: string, rawSource: string): string {
  let clean = rawSource;

  if (clean.startsWith('file://')) {
    clean = clean.slice(7);
  }

  const nodeModulesPattern = `node_modules/${moduleName}/`;
  const nodeModulesIndex = clean.indexOf(nodeModulesPattern);
  if (nodeModulesIndex === -1) {
    while (clean.startsWith('../')) {
      clean = clean.slice(3);
    }

    while (clean.startsWith('./')) {
      clean = clean.slice(2);
    }
  } else {
    clean = clean.slice(nodeModulesIndex + nodeModulesPattern.length);
  }

  clean = clean.replaceAll('\\', '/').replaceAll(/\/+/g, '/');
  return `${moduleName}/${clean}`;
}

/**
 * Apply library source maps to resolve library frames to original TS positions.
 * Uses a cache map that is populated lazily.
 *
 * @param frames - parsed stack frames to resolve
 * @param libraryPatterns - patterns identifying which frames belong to known libraries
 * @param getSourceMapConsumer - factory that returns a cached SourceMapConsumer for a given module name
 * @returns frames with library entries resolved to original source positions
 */
export function applyLibrarySourceMaps(
  frames: KernelStackFrame[],
  libraryPatterns: LibraryPattern[],
  getSourceMapConsumer: (moduleName: string) => SourceMapConsumer | undefined,
): KernelStackFrame[] {
  if (libraryPatterns.length === 0) {
    return frames;
  }

  return frames.map((frame) => {
    if (frame.context !== 'library' || !frame.fileName || !frame.lineNumber) {
      return frame;
    }

    const library = libraryPatterns.find((l) => frame.fileName!.includes(l.pattern));
    if (!library) {
      return frame;
    }

    const consumer = getSourceMapConsumer(library.moduleName);
    if (consumer) {
      try {
        const original = consumer.originalPositionFor({
          line: frame.lineNumber,
          column: (frame.columnNumber ?? 1) - 1,
        });

        if (original.source) {
          return {
            ...frame,
            fileName: resolveLibrarySourcePath(library.moduleName, original.source),
            // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- source-map-js returns null at runtime despite types saying number
            lineNumber: original.line ?? frame.lineNumber,
            // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- source-map-js returns null at runtime despite types saying number
            columnNumber: (original.column ?? 0) + 1,
            functionName: original.name ?? frame.functionName,
          };
        }
      } catch {
        // Fall through to path normalization
      }
    }

    return {
      ...frame,
      fileName: resolveLibrarySourcePath(library.moduleName, frame.fileName),
    };
  });
}

// =============================================================================
// Error Location Derivation
// =============================================================================

/**
 * Derive an ErrorLocation from the first user-context stack frame.
 * Optionally uses source map data to compute expression extent.
 *
 * @param frames - parsed stack frames to search for user context
 * @param sourceMapJson - optional raw source map JSON for expression extent computation
 * @param resolveSourcePathFunction - optional path resolver override
 * @returns location of the first user-authored frame, or `undefined` if none found
 */
export function deriveLocationFromFrames(
  frames: KernelStackFrame[],
  sourceMapJson?: string,
  resolveSourcePathFunction?: (sourcePath: string) => string,
): ErrorLocation | undefined {
  const userFrame = frames.find((frame) => frame.context === 'user');
  if (!userFrame?.fileName || !userFrame.lineNumber) {
    return undefined;
  }

  const startLineNumber = userFrame.lineNumber;
  let startColumn = userFrame.columnNumber ?? 1;
  let endColumn: number | undefined;

  if (sourceMapJson) {
    try {
      const extent = computeExpressionExtentFromSourceMap({
        sourceMapJson,
        fileName: userFrame.fileName,
        lineNumber: startLineNumber,
        startColumn,
        resolveSourcePathFn: resolveSourcePathFunction,
      });
      if (extent) {
        startColumn = extent.startColumn;
        endColumn = extent.endColumn;
      }
    } catch {
      // Fall through with no endColumn on source map errors
    }
  }

  return {
    fileName: userFrame.fileName,
    startLineNumber,
    startColumn,
    endLineNumber: endColumn === undefined ? undefined : startLineNumber,
    endColumn,
  };
}

/**
 * Compute the expression extent (start/end columns) from source map mapping data.
 *
 * @param options - source map lookup configuration with file name, line, column, and path resolver
 * @returns start and end column range, or undefined if the mapping cannot be resolved
 */
function computeExpressionExtentFromSourceMap(options: {
  sourceMapJson: string;
  fileName: string;
  lineNumber: number;
  startColumn: number;
  resolveSourcePathFn?: (sourcePath: string) => string;
}): { startColumn: number; endColumn: number } | undefined {
  const { sourceMapJson, fileName, lineNumber, startColumn, resolveSourcePathFn } = options;
  const rawMap: unknown = JSON.parse(sourceMapJson);
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- source-map-js accepts parsed JSON
  const consumer = new SourceMapConsumer(rawMap as any);
  const resolver = resolveSourcePathFn ?? ((s: string) => resolveSourcePath(s));

  let sourceName: string | undefined;
  for (const source of consumer.sources) {
    if (resolver(source) === fileName) {
      sourceName = source;
      break;
    }
  }

  if (!sourceName) {
    return undefined;
  }

  let adjustedStartColumn = startColumn;

  const sourceContent = consumer.sourceContentFor(sourceName) ?? undefined;
  if (sourceContent) {
    const lines = sourceContent.split('\n');
    const line = lines[lineNumber - 1];
    if (line && startColumn > 1 && line[startColumn - 2] === '.') {
      adjustedStartColumn = startColumn - 1;
    }
  }

  const columnsOnLine: number[] = [];
  consumer.eachMapping((mapping) => {
    if (mapping.source === sourceName && mapping.originalLine === lineNumber && mapping.originalColumn !== null) {
      columnsOnLine.push(mapping.originalColumn);
    }
  });

  if (columnsOnLine.length === 0) {
    return undefined;
  }

  const start0 = adjustedStartColumn - 1;
  const lastMappedColumn = columnsOnLine
    .filter((col) => col >= start0)
    .sort((a, b) => a - b)
    .pop();

  if (lastMappedColumn === undefined) {
    return undefined;
  }

  return { startColumn: adjustedStartColumn, endColumn: lastMappedColumn + 2 };
}
