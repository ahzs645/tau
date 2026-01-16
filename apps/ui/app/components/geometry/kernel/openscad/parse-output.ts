import type { ErrorLocation, KernelIssue } from '@taucad/types';

/**
 * Callback function type for adding parsed errors.
 */
export type AddErrorFn = (error: KernelIssue) => void;

/**
 * Function type for lazily fetching file contents on demand.
 * Takes a normalized filename and returns the file content, or undefined if not found.
 */
export type GetFileContentsFn = (fileName: string) => string | undefined;

/**
 * Extract the basename (filename without directory path) from a full path.
 *
 * @param path - The full file path.
 * @returns The basename (e.g., 'main.scad' from 'site/main.scad').
 */
function getBasename(path: string): string {
  const lastSlashIndex = path.lastIndexOf('/');
  return lastSlashIndex === -1 ? path : path.slice(lastSlashIndex + 1);
}

/**
 * Normalize a filename by removing leading slashes and optionally mapping
 * the main file basename to its full relative path.
 *
 * OpenSCAD outputs absolute paths like "/main.scad" but we want relative paths.
 * Additionally, when the main file is in a subdirectory (e.g., "site/backyard.scad"),
 * OpenSCAD only reports the basename, so we need to map it back to the full path.
 *
 * @param fileName - The filename to normalize.
 * @param mainFilePath - Optional full relative path of the main file (e.g., "site/backyard.scad").
 * @returns The normalized filename, with main file basename mapped to full path if applicable.
 */
function normalizeFileName(fileName: string, mainFilePath?: string): string {
  const normalized = fileName.replace(/^\/+/, '');

  // If a main file path is provided and the normalized filename matches its basename,
  // return the full path instead of just the basename
  if (mainFilePath) {
    const mainBasename = getBasename(mainFilePath);
    if (normalized === mainBasename) {
      return mainFilePath;
    }
  }

  return normalized;
}

/**
 * Get a specific line from file contents using the getter function.
 * Returns undefined if the file or line is not found.
 *
 * @param getFileContents - Function to lazily fetch file content.
 * @param fileName - The normalized filename to look up.
 * @param lineNumber - The 1-based line number.
 * @returns The line content, or undefined if not found.
 */
function getLine(
  getFileContents: GetFileContentsFn | undefined,
  fileName: string,
  lineNumber: number,
): string | undefined {
  if (!getFileContents) {
    return undefined;
  }

  const content = getFileContents(fileName);
  if (!content) {
    return undefined;
  }

  const lines = content.split('\n');
  const lineIndex = lineNumber - 1; // Convert to 0-based index

  if (lineIndex < 0 || lineIndex >= lines.length) {
    return undefined;
  }

  return lines[lineIndex];
}

/**
 * Get the index of the first non-whitespace character in a string.
 *
 * @param line - The line content.
 * @returns The 0-based index of the first non-whitespace character, or 0 if all whitespace.
 */
function getFirstNonWhitespaceIndex(line: string): number {
  const match = /\S/.exec(line);
  return match?.index ?? 0;
}

/**
 * Create an ErrorLocation with proper start and end positions based on line content.
 * The start column is the first non-whitespace character, and end column is after the last character.
 * Both columns are 1-based to match Monaco editor conventions.
 *
 * @param fileName - The normalized filename.
 * @param lineNumber - The 1-based line number.
 * @param getFileContents - Optional function to lazily fetch file content.
 * @returns The ErrorLocation with 1-based start and end positions.
 */
function createErrorLocation(
  fileName: string,
  lineNumber: number,
  getFileContents: GetFileContentsFn | undefined,
): ErrorLocation {
  const lineContent = getLine(getFileContents, fileName, lineNumber);

  if (lineContent === undefined) {
    // Fallback when line content is not available (1-based columns)
    return {
      fileName,
      startLineNumber: lineNumber,
      startColumn: 1,
      endLineNumber: lineNumber,
      endColumn: 1000,
    };
  }

  // Convert 0-based index to 1-based column
  const startColumn = getFirstNonWhitespaceIndex(lineContent) + 1;
  const endColumn = lineContent.length + 1;

  return {
    fileName,
    startLineNumber: lineNumber,
    startColumn,
    endLineNumber: lineNumber,
    endColumn,
  };
}

/**
 * Parse a single stderr line from OpenSCAD and call addError if it matches a known error pattern.
 *
 * Supports the following OpenSCAD error/warning formats:
 * - `ERROR: Parser error in file "foo.scad", line 10: syntax error`
 * - `ERROR: Parser error: syntax error in file foo.scad, line 10`
 * - `WARNING: message in file foo.scad, line 10`
 * - `ERROR: Assertion 'condition' failed in file "foo.scad", line 10`
 * - `ERROR: message in file "foo.scad", line 10` (generic error)
 * - `Current top level object is empty.` (special case: no geometry rendered)
 *
 * @param message - The stderr line to parse.
 * @param addError - Callback to invoke when an error is parsed.
 * @param getFileContents - Optional function to lazily fetch file content for calculating column positions.
 * @param mainFilePath - Optional full relative path of the main file (e.g., "site/backyard.scad").
 *                       Used to map basename errors back to full paths for FileLink navigation.
 */
export function parseStderrLine(
  message: string,
  addError: AddErrorFn,
  getFileContents?: GetFileContentsFn,
  mainFilePath?: string,
): void {
  // Pattern 1: ERROR: Parser error in file "foo.scad", line 10: syntax error
  let match = /^ERROR: Parser error in file "([^"]+)", line (\d+): (.*)$/.exec(message);
  if (match) {
    const [, file, line, error] = match;
    const fileName = normalizeFileName(file ?? '', mainFilePath);
    const lineNumber = Number(line);
    addError({
      message: error ?? 'Unknown error',
      location: createErrorLocation(fileName, lineNumber, getFileContents),
      type: 'compilation',
      severity: 'error',
    });
    return;
  }

  // Pattern 2: ERROR: Parser error: syntax error in file foo.scad, line 10
  match = /^ERROR: Parser error: (.*?) in file ([^,]+), line (\d+)$/.exec(message);
  if (match) {
    const [, error, file, line] = match;
    const fileName = normalizeFileName(file ?? '', mainFilePath);
    const lineNumber = Number(line);
    addError({
      message: error ?? 'Unknown error',
      location: createErrorLocation(fileName, lineNumber, getFileContents),
      type: 'compilation',
      severity: 'error',
    });
    return;
  }

  // Pattern 3: WARNING messages
  match = /^WARNING: (.*?),? in file ([^,]+), line (\d+)\.?/.exec(message);
  if (match) {
    const [, warning, file, line] = match;
    const fileName = normalizeFileName(file ?? '', mainFilePath);
    const lineNumber = Number(line);
    addError({
      message: warning ?? 'Unknown warning',
      location: createErrorLocation(fileName, lineNumber, getFileContents),
      type: 'compilation',
      severity: 'warning',
    });
    return;
  }

  // Pattern 4: Assertion failures - ERROR: Assertion 'condition' failed in file "foo.scad", line 10
  match = /^ERROR: (Assertion .*?) in file "?([^",]+)"?, line (\d+)/.exec(message);
  if (match) {
    const [, error, file, line] = match;
    const fileName = normalizeFileName(file ?? '', mainFilePath);
    const lineNumber = Number(line);
    addError({
      message: error ?? 'Assertion failed',
      location: createErrorLocation(fileName, lineNumber, getFileContents),
      type: 'runtime',
      severity: 'error',
    });
    return;
  }

  // Pattern 5: Generic ERROR messages with file/line info
  match = /^ERROR: (.*?) in file "?([^",]+)"?, line (\d+)/.exec(message);
  if (match) {
    const [, error, file, line] = match;
    const fileName = normalizeFileName(file ?? '', mainFilePath);
    const lineNumber = Number(line);
    addError({
      message: error ?? 'Unknown error',
      location: createErrorLocation(fileName, lineNumber, getFileContents),
      type: 'runtime',
      severity: 'error',
    });
    return;
  }

  // Pattern 6: Empty top level object (no geometry to render)
  // This occurs when a file only defines modules but doesn't call any of them
  if (message.includes('Current top level object is empty')) {
    addError({
      message:
        'No geometry to render. Call a module or add a primitive (e.g., cube(), sphere()) to create visible output.',
      location: mainFilePath ? { fileName: mainFilePath, startLineNumber: 1, startColumn: 1 } : undefined,
      type: 'runtime',
      severity: 'warning',
    });
  }
}
