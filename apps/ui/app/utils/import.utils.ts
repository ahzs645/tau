/**
 * Import Resolution Utilities
 *
 * Shared pure functions for import specifier parsing and path resolution.
 * Used by both the kernel worker (esbuild bundling) and the main thread
 * (Monaco navigation, type acquisition).
 *
 * All functions are pure -- no filesystem or network access.
 */

import { parsePackage } from 'cdn-resolve';

// =============================================================================
// Types
// =============================================================================

export type PackageInfo = {
  name: string;
  version: string;
  path: string;
};

// =============================================================================
// Root-level node_modules cache path
// =============================================================================

/**
 * Root directory for the CDN module cache in the virtual filesystem.
 * Lives at the filesystem root (`/`), outside any project directory (`/builds/xyz/`),
 * so cached modules are shared across all projects and persist across builds.
 */
const nodeModulesRoot = '/node_modules';

// =============================================================================
// Specifier Classification
// =============================================================================

/**
 * Check if a specifier is a bare import (not relative, absolute, or URL).
 *
 * Bare specifiers are package names like 'replicad', '@jscad/modeling', or 'lodash/debounce'.
 * Non-bare specifiers include relative paths ('./foo'), absolute paths ('/foo'),
 * and URLs ('https://cdn.example.com/foo').
 *
 * This utility is shared between the kernel worker (module resolution)
 * and the main thread (type acquisition).
 */
export function isBareSpecifier(specifier: string): boolean {
  return !(
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/') ||
    specifier.startsWith('http://') ||
    specifier.startsWith('https://')
  );
}

// =============================================================================
// Package Specifier Parsing
// =============================================================================

/**
 * Parse a package specifier into name, version, and path components.
 * Uses cdn-resolve's parsePackage for robust parsing.
 *
 * Examples:
 * - 'replicad' -> { name: 'replicad', version: '', path: '' }
 * - 'replicad@0.19.1' -> { name: 'replicad', version: '0.19.1', path: '' }
 * - '@jscad/modeling@2.12.6/primitives' -> { name: '@jscad/modeling', version: '2.12.6', path: 'primitives' }
 */
export function parsePackageSpecifier(specifier: string): PackageInfo {
  const parsed = parsePackage(specifier);
  // Cdn-resolve returns path with leading slash, but we need it without
  const parsedPath = parsed.path ?? '';
  const normalizedPath = parsedPath.startsWith('/') ? parsedPath.slice(1) : parsedPath;
  // Cdn-resolve returns 'latest' when no version specified, but we want ''
  const version = parsed.version === 'latest' ? '' : parsed.version;
  return {
    name: parsed.name,
    version,
    path: normalizedPath,
  };
}

// =============================================================================
// Path Resolution
// =============================================================================

/**
 * Resolve a relative import path against the importing file's directory.
 *
 * @param specifier - The relative import (e.g., './utils.ts', '../helpers.ts')
 * @param fromPath - Absolute path of the importing file
 * @returns Resolved absolute path
 */
export function resolveRelativePath(specifier: string, fromPath: string): string {
  const directory = fromPath.slice(0, fromPath.lastIndexOf('/'));

  if (specifier.startsWith('./')) {
    return `${directory}/${specifier.slice(2)}`;
  }

  if (specifier.startsWith('../')) {
    const parts = directory.split('/');
    let upCount = 0;
    let remaining = specifier;

    while (remaining.startsWith('../')) {
      upCount++;
      remaining = remaining.slice(3);
    }

    const newParts = parts.slice(0, -upCount);
    return `${newParts.join('/')}/${remaining}`;
  }

  return specifier;
}

// =============================================================================
// Node Modules Path Helpers
// =============================================================================

/**
 * Get the root-level node_modules directory path for a package.
 *
 * @param packageName - Package name (e.g., 'lodash', '@jscad/modeling')
 * @returns Absolute path (e.g., '/node_modules/lodash')
 */
export function getNodeModulesPath(packageName: string): string {
  return `${nodeModulesRoot}/${packageName}`;
}

/**
 * Get the full file path for a cached CDN module.
 *
 * @param packageName - Package name (e.g., 'lodash')
 * @param subpath - Optional subpath (e.g., 'debounce')
 * @returns Absolute file path:
 *   - No subpath: '/node_modules/lodash/index.js'
 *   - With subpath: '/node_modules/lodash/debounce.js'
 */
export function getCdnCachePath(packageName: string, subpath?: string): string {
  const basePath = getNodeModulesPath(packageName);
  if (subpath) {
    return `${basePath}/${subpath}.js`;
  }

  return `${basePath}/index.js`;
}
