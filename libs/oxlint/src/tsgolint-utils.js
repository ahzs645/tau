/**
 * Shared tsgolint (typescript-go) utilities for type-checking code blocks.
 * Used by both JSDoc codeblock validation and MDX codeblock validation rules.
 *
 * @typedef {{ kind: number; range?: { pos: number; end: number }; message: { id: string; description: string }; file_path?: string }} TsgolintDiagnostic
 * @typedef {{ virtualPath: string; strippedCode: string; codeStartIndex: number; mapToRaw: (offset: number) => number }} CodeblockEntry
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

/** @type {string | undefined} */
let cachedTsgolintBinary;
let tsgolintResolved = false;

/**
 * Resolve the tsgolint binary path from the workspace node_modules.
 * Caches the result after first resolution.
 *
 * @public
 * @returns {string | undefined}
 */
export function resolveTsgolintBinary() {
  if (tsgolintResolved) {
    return cachedTsgolintBinary;
  }
  tsgolintResolved = true;

  const workspaceRoot = process.env.NX_WORKSPACE_ROOT ?? path.resolve(import.meta.dirname, '..', '..', '..');
  const rootRequire = createRequire(path.join(workspaceRoot, 'node_modules', '_placeholder.js'));
  try {
    const wrapperPath = rootRequire.resolve('oxlint-tsgolint/bin/tsgolint.js');
    const wrapperRequire = createRequire(wrapperPath);
    const suffix = process.platform === 'win32' ? '.exe' : '';
    cachedTsgolintBinary = wrapperRequire.resolve(
      `@oxlint-tsgolint/${process.platform}-${process.arch}/tsgolint${suffix}`,
    );
  } catch {
    cachedTsgolintBinary = undefined;
  }
  return cachedTsgolintBinary;
}

/**
 * Parse binary-framed tsgolint output.
 * Wire format: [uint32 LE size][uint8 type (0=Error, 1=Diagnostic)][UTF-8 JSON]
 *
 * @public
 * @param {Buffer} buffer
 * @returns {TsgolintDiagnostic[]}
 */
export function parseDiagnostics(buffer) {
  /** @type {TsgolintDiagnostic[]} */
  const diagnostics = [];
  let offset = 0;

  while (offset + 5 <= buffer.length) {
    const payloadSize = buffer.readUInt32LE(offset);
    const messageType = buffer[offset + 4];
    offset += 5;

    if (offset + payloadSize > buffer.length) {
      break;
    }

    const payload = buffer.subarray(offset, offset + payloadSize).toString('utf8');
    offset += payloadSize;

    if (messageType === 1) {
      try {
        diagnostics.push(JSON.parse(payload));
      } catch {
        // Malformed payload -- skip silently
      }
    }
  }

  return diagnostics;
}

/**
 * Run tsgolint headless on a batch of code blocks with source overrides.
 *
 * @public
 * @param {string} binary
 * @param {CodeblockEntry[]} blocks
 * @returns {TsgolintDiagnostic[]}
 */
export function runTsgolint(binary, blocks) {
  /** @type {Record<string, string>} */
  const sourceOverrides = {};
  const filePaths = [];

  for (const block of blocks) {
    sourceOverrides[block.virtualPath] = block.strippedCode;
    filePaths.push(block.virtualPath);
  }

  const result = spawnSync(binary, ['headless'], {
    input: JSON.stringify({
      version: 2,
      configs: [{ file_paths: filePaths, rules: [] }],
      source_overrides: sourceOverrides,
      report_syntactic: true,
      report_semantic: true,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    return [];
  }

  if (!result.stdout || result.stdout.length === 0) {
    return [];
  }

  return parseDiagnostics(result.stdout);
}
