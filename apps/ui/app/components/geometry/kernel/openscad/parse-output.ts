import type { KernelError } from '@taucad/types';

/**
 * Callback function type for adding parsed errors.
 */
export type AddErrorFn = (error: KernelError) => void;

/**
 * Normalize a filename by removing leading slashes.
 * OpenSCAD outputs absolute paths like "/main.scad" but we want relative paths.
 *
 * @param fileName - The filename to normalize.
 * @returns The normalized filename without leading slashes.
 */
function normalizeFileName(fileName: string): string {
  return fileName.replace(/^\/+/, '');
}

/**
 * Parse a single stderr line from OpenSCAD and call addError if it matches a known error pattern.
 *
 * Supports the following OpenSCAD error/warning formats:
 * - `ERROR: Parser error in file "foo.scad", line 10: syntax error`
 * - `ERROR: Parser error: syntax error in file foo.scad, line 10`
 * - `WARNING: message in file foo.scad, line 10`
 *
 * @param message - The stderr line to parse.
 * @param addError - Callback to invoke when an error is parsed.
 */
export function parseStderrLine(message: string, addError: AddErrorFn): void {
  // Pattern 1: ERROR: Parser error in file "foo.scad", line 10: syntax error
  let match = /^ERROR: Parser error in file "([^"]+)", line (\d+): (.*)$/.exec(message);
  if (match) {
    const [, file, line, error] = match;
    addError({
      message: error ?? 'Unknown error',
      location: { fileName: normalizeFileName(file ?? ''), startLineNumber: Number(line), startColumn: 0 },
      type: 'compilation',
    });
    return;
  }

  // Pattern 2: ERROR: Parser error: syntax error in file foo.scad, line 10
  match = /^ERROR: Parser error: (.*?) in file ([^,]+), line (\d+)$/.exec(message);
  if (match) {
    const [, error, file, line] = match;
    addError({
      message: error ?? 'Unknown error',
      location: { fileName: normalizeFileName(file ?? ''), startLineNumber: Number(line), startColumn: 0 },
      type: 'compilation',
    });
    return;
  }

  // Pattern 3: WARNING messages
  match = /^WARNING: (.*?),? in file ([^,]+), line (\d+)\.?/.exec(message);
  if (match) {
    const [, warning, file, line] = match;
    addError({
      message: warning ?? 'Unknown warning',
      location: { fileName: normalizeFileName(file ?? ''), startLineNumber: Number(line), startColumn: 0 },
      type: 'compilation',
    });
  }
}

