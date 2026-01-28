// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- emscripten types are not available as a module
/// <reference types="emscripten" />

import opencascade from 'replicad-opencascadejs/src/replicad_single.js';
import type { OpenCascadeInstance } from 'replicad-opencascadejs/src/replicad_single.js';
import opencascadeWithExceptions from 'replicad-opencascadejs/src/replicad_with_exceptions.js';
import type { OpenCascadeInstance as OpenCascadeInstanceWithExceptions } from 'replicad-opencascadejs/src/replicad_with_exceptions.js';
import { asBuffer } from '#utils/file.utils.js';

// WASM URLs using universal pattern for browsers and bundlers
// WASM files are copied from node_modules via copy-files-from-to
// @see https://web.dev/articles/bundling-non-js-resources#universal_pattern_for_browsers_and_bundlers
export const opencascadeWasmUrl = new URL('wasm/replicad_single.wasm', import.meta.url).href;
export const opencascadeWithExceptionsWasmUrl = new URL('wasm/replicad_with_exceptions.wasm', import.meta.url).href;

// Types for OpenCascade modules
type OpenCascadeModule = (options?: Partial<EmscriptenModule>) => Promise<OpenCascadeInstance>;
type OpenCascadeModuleWithExceptions = (
  options?: Partial<EmscriptenModule>,
) => Promise<OpenCascadeInstanceWithExceptions>;

/**
 * Options for initializing OpenCascade.
 */
type InitOpenCascadeOptions = {
  /** Optional callback to handle stdout messages. Defaults to no-op (silences logs). */
  print?: (text: string) => void;
  /** Optional callback to handle stderr messages. Defaults to no-op (silences logs). */
  printErr?: (text: string) => void;
};

// Default no-op function to silence verbose OpenCascade logs
// eslint-disable-next-line @typescript-eslint/no-empty-function -- Intentional no-op to silence logs
const noop = (): void => {};

/**
 * Load WASM binary using feature detection (try/catch) rather than environment checks.
 * Tries fetch first (works in browsers), falls back to fs.readFile for file:// URLs (Node.js).
 * @see https://www.zachleat.com/web/dynamic-import/ - similar pattern to import-module-string
 */
async function loadWasmBinary(url: string): Promise<ArrayBuffer> {
  try {
    // Try fetch first - works in browsers and some Node.js versions
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch WASM binary from ${url}: ${response.status} ${response.statusText}`);
    }

    return await response.arrayBuffer();
  } catch (error) {
    // Only attempt Node.js fs fallback for file:// URLs
    if (!url.startsWith('file:')) {
      throw error;
    }

    // Fallback: use Node.js fs for file:// URLs
    // Dynamic imports avoid bundler issues in browser builds
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Node.js API
    const { fileURLToPath } = await import('node:url');
    const { readFile } = await import('node:fs/promises');
    const filePath = fileURLToPath(url);
    const buffer = await readFile(filePath);
    return asBuffer(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  }
}

/**
 * Initialize OpenCascade with the single (non-exception) WASM module.
 * Uses fetch + wasmBinary pattern that works in both Node.js and browser environments.
 * @param options - Optional callbacks for stdout/stderr. Defaults to silencing logs.
 * @see https://github.com/sgenoud/replicad-cli/blob/main/src/initOCSingle.js
 */
export async function initOpenCascade(options?: InitOpenCascadeOptions): Promise<OpenCascadeInstance> {
  // Load WASM binary using fetch - handles both file:// and http:// URLs
  const wasmBinary = await loadWasmBinary(opencascadeWasmUrl);

  const instance = await (opencascade as OpenCascadeModule)({
    wasmBinary,
    // Silence verbose OpenCascade logs by default (Statistics on Transfer, etc.)
    print: options?.print ?? noop,
    printErr: options?.printErr ?? noop,
    // Use a larger memory allocation for better performance
    // eslint-disable-next-line @typescript-eslint/naming-convention -- this is a valid property
    TOTAL_MEMORY: 256 * 1024 * 1024, // 256MB
  });

  return instance;
}

/**
 * Initialize OpenCascade with exceptions support for detailed error information.
 * Uses fetch + wasmBinary pattern that works in both Node.js and browser environments.
 * @param options - Optional callbacks for stdout/stderr. Defaults to silencing logs.
 * @see https://github.com/sgenoud/replicad-cli/blob/main/src/initOCSingle.js
 */
export async function initOpenCascadeWithExceptions(
  options?: InitOpenCascadeOptions,
): Promise<OpenCascadeInstanceWithExceptions> {
  // Load WASM binary using fetch - handles both file:// and http:// URLs
  const wasmBinary = await loadWasmBinary(opencascadeWithExceptionsWasmUrl);

  const instance = await (opencascadeWithExceptions as OpenCascadeModuleWithExceptions)({
    wasmBinary,
    // Silence verbose OpenCascade logs by default (Statistics on Transfer, etc.)
    print: options?.print ?? noop,
    printErr: options?.printErr ?? noop,
    // Use a larger memory allocation for better performance
    // eslint-disable-next-line @typescript-eslint/naming-convention -- this is a valid property
    TOTAL_MEMORY: 256 * 1024 * 1024, // 256MB
  });

  return instance;
}
