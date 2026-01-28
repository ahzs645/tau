/**
 * Utilities for detecting and parsing import paths in KCL code.
 */

import type * as Monaco from 'monaco-editor';

/**
 * Result of detecting an import path at a position.
 */
export type ImportPathAtPosition = {
  /** The import path (without quotes) */
  path: string;
  /** The byte range in the line (0-based, includes quotes) */
  range: { start: number; end: number };
};

/**
 * Check if the cursor is inside an import path string and return the path.
 * Handles patterns like:
 * - import "car-wheel.kcl" as carWheel
 * - import * from "parameters.kcl"
 * - import { foo } from "module.kcl"
 */
export function getImportPathAtPosition(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): ImportPathAtPosition | undefined {
  const lineContent = model.getLineContent(position.lineNumber);
  const { column } = position;

  // Find if cursor is inside a quoted string
  // Look for opening quote before cursor
  let stringStart = -1;
  let quoteChar = '';
  for (let index = column - 2; index >= 0; index--) {
    const char = lineContent[index];
    // Check if it's a quote that's an opening quote (not preceded by backslash)
    if ((char === '"' || char === "'") && (index === 0 || lineContent[index - 1] !== '\\')) {
      stringStart = index;
      quoteChar = char;
      break;
    }
  }

  if (stringStart === -1) {
    return undefined;
  }

  // Find closing quote after cursor
  let stringEnd = -1;
  for (let index = column - 1; index < lineContent.length; index++) {
    const char = lineContent[index];
    if (char === quoteChar && lineContent[index - 1] !== '\\') {
      stringEnd = index;
      break;
    }
  }

  if (stringEnd === -1) {
    return undefined;
  }

  // Extract the string content (without quotes)
  const path = lineContent.slice(stringStart + 1, stringEnd);

  // Check if this looks like a module import (either .kcl file or module name)
  // For hover, we want to show module info even for non-.kcl imports
  // The definition provider should handle .kcl filtering separately

  // Check if this line is an import statement
  const trimmedLine = lineContent.trim();
  if (!trimmedLine.startsWith('import ')) {
    return undefined;
  }

  return {
    path,
    range: { start: stringStart, end: stringEnd },
  };
}

/**
 * Check if a path looks like a KCL file import.
 */
export function isKclFileImport(path: string): boolean {
  return path.endsWith('.kcl');
}
