/**
 * KCL Import Resolution Utility
 *
 * Shared utility for discovering file dependencies in KCL programs.
 * Used by both the worker (for cache key computation) and potentially the LSP.
 */

import type { Node } from '@taucad/kcl-wasm-lib/bindings/Node';
import type { Program } from '@taucad/kcl-wasm-lib/bindings/Program';
import type { BodyItem } from '@taucad/kcl-wasm-lib/bindings/BodyItem';
import type { ImportStatement } from '@taucad/kcl-wasm-lib/bindings/ImportStatement';

/**
 * Parse function interface - matches KclUtils.parseKcl signature
 */
export type ParseKclFunction = (code: string) => Promise<{
  program: Node<Program>;
  errors: unknown[];
  warnings: unknown[];
}>;

/**
 * Read file function interface for dependency resolution
 */
export type ReadFileFunction = (path: string) => Promise<string>;

/**
 * Extract import paths from a KCL program AST.
 * Returns paths as they appear in import statements (relative paths to local KCL files).
 * Only extracts local KCL file imports, not stdlib imports.
 *
 * @param program - The parsed KCL program AST
 * @returns Array of relative file paths that are imported
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- KCL WASM API
export function extractLocalImportPaths(program: Node<Program> | null): string[] {
  const importPaths: string[] = [];

  // Handle case where program or program.body is null (e.g., parse error)
  if (!program) {
    return importPaths;
  }

  for (const bodyItem of program.body) {
    if (bodyItem.type === 'ImportStatement') {
      const importPath = extractImportPath(bodyItem);
      if (importPath) {
        importPaths.push(importPath);
      }
    }
  }

  return importPaths;
}

/**
 * Extract the import path from an ImportStatement body item.
 * Only extracts local KCL file paths, not stdlib or foreign imports.
 *
 * @param item - The body item (must be an ImportStatement)
 * @returns The relative file path, or undefined if not a local KCL import
 */
function extractImportPath(item: BodyItem & { type: 'ImportStatement' }): string | undefined {
  const importStmt = item as unknown as Node<ImportStatement>;
  const pathValue = importStmt.path;

  // Only extract local KCL file imports: { type: 'Kcl', filename: 'bench-parts.kcl' }
  if ('filename' in pathValue && typeof pathValue.filename === 'string') {
    return pathValue.filename;
  }

  // Skip stdlib and foreign imports - they don't affect caching
  return undefined;
}

/**
 * Resolve an import path relative to the current file.
 *
 * @param currentFilePath - The current file path (e.g., 'bench/main.kcl')
 * @param importPath - The relative import path (e.g., 'bench-parts.kcl')
 * @returns The resolved path relative to the project root
 */
function resolveRelativeImportPath(currentFilePath: string, importPath: string): string {
  // Get directory of current file
  const lastSlashIndex = currentFilePath.lastIndexOf('/');
  const directory = lastSlashIndex === -1 ? '' : currentFilePath.slice(0, lastSlashIndex + 1);

  // Join with the import path
  return `${directory}${importPath}`;
}

/**
 * Recursively discover all file dependencies for a KCL program.
 * Reads imported files and traverses their imports.
 *
 * @param entryFile - The entry file path (relative to basePath)
 * @param readFile - Function to read file contents
 * @param parseKcl - Function to parse KCL code into AST
 * @returns Array of file paths that are dependencies (including the entry file)
 */
export async function discoverKclDependencies(
  entryFile: string,
  readFile: ReadFileFunction,
  parseKcl: ParseKclFunction,
): Promise<string[]> {
  const visited = new Set<string>();
  const result: string[] = [];

  /**
   * Normalize and canonicalize a file path.
   * Removes leading slashes and resolves `.` and `..` segments to ensure
   * consistent path representation for deduplication and cache key stability.
   */
  const normalizePath = (path: string): string => {
    // Remove leading slashes
    const normalized = path.replace(/^\/+/, '');
    // Resolve . and .. segments
    const parts = normalized.split('/');
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === '..') {
        resolved.pop();
      } else if (part !== '.' && part !== '') {
        resolved.push(part);
      }
    }

    return resolved.join('/');
  };

  /**
   * Maximum import depth limit.
   * 50 levels of import depth should handle any reasonable project structure
   * while preventing infinite loops from circular imports that somehow bypass
   * the visited check (e.g., due to path resolution edge cases).
   */
  const maxDepth = 50;

  const resolveFile = async (filePath: string, depth: number): Promise<void> => {
    const normalizedPath = normalizePath(filePath);

    // Check depth limit
    if (depth >= maxDepth) {
      return;
    }

    // Skip if already visited (handles circular dependencies)
    if (visited.has(normalizedPath)) {
      return;
    }

    visited.add(normalizedPath);

    // Try to read and parse the file
    let code: string;
    try {
      code = await readFile(normalizedPath);
    } catch {
      // File doesn't exist or can't be read - skip it
      return;
    }

    // Add this file to results
    result.push(normalizedPath);

    // Parse the file to extract imports
    let program: Node<Program>;
    try {
      const parseResult = await parseKcl(code);
      program = parseResult.program;
    } catch {
      // Parse error - file is still a dependency, but we can't traverse further
      return;
    }

    // Extract and resolve imports
    const importPaths = extractLocalImportPaths(program);

    for (const importPath of importPaths) {
      const resolvedPath = resolveRelativeImportPath(normalizedPath, importPath);
      // eslint-disable-next-line no-await-in-loop -- Sequential processing required for proper depth tracking
      await resolveFile(resolvedPath, depth + 1);
    }
  };

  await resolveFile(entryFile, 0);

  return result;
}
