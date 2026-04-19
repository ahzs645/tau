import { nodeExecFilePrefix } from '#bundler/esbuild.constants.js';

let counter = 0;

/**
 * Strip inline source map comments to prevent Node.js `--enable-source-maps`
 * from applying them before our own `parseStackTrace` has a chance to.
 */
function stripInlineSourceMap(code: string): string {
  return code.replace(/\/\/# sourceMappingURL=data:[^\n]+$/m, '');
}

/**
 * Node.js code execution via temp file import.
 *
 * ESM loader hooks (`@oxc-node/core/register`, `tsx`, `ts-node/esm`) intercept
 * `import()` and reject `data:text/javascript` URLs with `ERR_UNKNOWN_BUILTIN_MODULE`.
 * Writing to a temp `.mjs` file and importing that path is universally supported.
 *
 * The inline source map is stripped before writing so that Node.js's built-in
 * source map support does not pre-resolve paths — our `parseStackTrace` handles
 * source map resolution with correct project-relative path resolution.
 *
 * @param code - bundled JavaScript code to execute
 * @returns the module exports and the entry URL used for import
 *
 * @public
 */
export async function executeCodeNode(code: string): Promise<{ value: unknown; entryUrl: string }> {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const temporaryFile = path.join(os.tmpdir(), `${nodeExecFilePrefix}${process.pid}-${++counter}.mjs`);
  const entryUrl = `file://${temporaryFile}?v=${counter}`;
  fs.writeFileSync(temporaryFile, stripInlineSourceMap(code), 'utf8');
  try {
    const value: unknown = await import(/* @vite-ignore */ entryUrl);
    return { value, entryUrl };
  } finally {
    try {
      fs.unlinkSync(temporaryFile);
    } catch {
      // Best-effort cleanup — OS will reclaim on next reboot
    }
  }
}
