/**
 * UI-Side Module Resolver
 *
 * Resolves module specifiers to filesystem paths for Monaco navigation.
 * Uses existing FileManager.exists() API for path checking.
 *
 * Returns root-level paths (e.g., /main.ts) for Monaco URIs.
 *
 * Note: Bare specifiers (e.g., 'replicad', 'lodash') return `undefined`.
 * Go-to-definition for packages is handled by Monaco's built-in TypeScript
 * language service via types injected by the TypeAcquisitionService.
 * The CDN-cached code at root `/node_modules/` is minified bundle output
 * and not useful for navigation.
 */

import type { FileManagerApi } from '#machines/file-manager.machine.types.js';
import { isBareSpecifier } from '#utils/import.utils.js';

export type ResolveResult = {
  /** Root-level path for Monaco URI (e.g., /lib/utils.ts) */
  resolvedPath: string;
  /** Whether this is a CDN URL (not cached locally) */
  isCdn: boolean;
};

/**
 * Module resolver for Monaco navigation.
 * Resolves import specifiers to root-level filesystem paths.
 */
export class ModuleResolver {
  public constructor(
    // @ts-expect-error -- TypeScript erasableSyntaxOnly doesn't support parameter properties, but ESLint requires them
    private readonly fileManager: Pick<FileManagerApi, 'exists'>,
  ) {}

  /**
   * Resolve a module specifier to a filesystem path.
   *
   * @param specifier - The import specifier (e.g., 'replicad', './utils')
   * @param fromPath - The file making the import (relative to project root)
   * @returns Resolved path or undefined if not found
   */
  public async resolveModule(specifier: string, fromPath: string): Promise<ResolveResult | undefined> {
    // 1. Handle CDN URLs
    if (specifier.startsWith('http://') || specifier.startsWith('https://')) {
      return { resolvedPath: specifier, isCdn: true };
    }

    // 2. Bare specifiers: return undefined
    // Navigation for packages is handled via ATA-injected types in Monaco's TS language service
    if (isBareSpecifier(specifier)) {
      return undefined;
    }

    // 3. Handle relative imports
    return this.resolveRelative(specifier, fromPath);
  }

  private async resolveRelative(specifier: string, fromPath: string): Promise<ResolveResult | undefined> {
    const directory = fromPath.slice(0, Math.max(0, fromPath.lastIndexOf('/'))) || '';
    const basePath = this.normalizePath(`${directory}/${specifier}`);

    // Extension resolution order (common TypeScript project conventions)
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

    // Try each extension until we find a match (sequential is intentional for short-circuit)
    // oxlint-disable-next-line unicorn-js/prevent-abbreviations -- ext is conventional abbreviation for extension
    for (const ext of extensions) {
      const fullPath = basePath + ext;
      // oxlint-disable-next-line no-await-in-loop -- Sequential checks to short-circuit on first match
      if (await this.fileManager.exists(fullPath)) {
        return {
          resolvedPath: `/${fullPath}`,
          isCdn: false,
        };
      }
    }

    return undefined;
  }

  private normalizePath(path: string): string {
    const parts = path.split('/').filter(Boolean);
    const result: string[] = [];
    for (const part of parts) {
      if (part === '..') {
        result.pop();
      } else if (part !== '.') {
        result.push(part);
      }
    }

    return result.join('/');
  }
}
