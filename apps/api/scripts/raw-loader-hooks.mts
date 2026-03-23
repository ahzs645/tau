/**
 * Node.js ESM loader hooks for Vite-style `?raw` imports.
 *
 * Intercepts specifiers ending with `?raw`, reads the target file as UTF-8,
 * and returns it as a default string export. This allows the benchmark CLI
 * to resolve prompt example files that use `import x from './file.ts?raw'`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rawSuffix = '?raw';

type ResolveContext = {
  parentURL?: string;
  conditions: string[];
};

type LoadContext = {
  format?: string;
  conditions: string[];
};

type NextResolve = (specifier: string, context: ResolveContext) => Promise<{ url: string; format?: string }>;
type NextLoad = (url: string, context: LoadContext) => Promise<{ source: string | ArrayBuffer; format: string }>;

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<{ url: string; format?: string; shortCircuit?: boolean }> {
  if (!specifier.endsWith(rawSuffix)) {
    return nextResolve(specifier, context);
  }

  const cleanSpecifier = specifier.slice(0, -rawSuffix.length);
  const resolved = await nextResolve(cleanSpecifier, context);

  return {
    url: resolved.url + rawSuffix,
    format: 'module',
    shortCircuit: true,
  };
}

export async function load(
  url: string,
  context: LoadContext,
  nextLoad: NextLoad,
): Promise<{ source: string; format: string; shortCircuit?: boolean }> {
  if (!url.endsWith(rawSuffix)) {
    return nextLoad(url, context);
  }

  const cleanUrl = url.slice(0, -rawSuffix.length);
  const filePath = fileURLToPath(cleanUrl);
  const content = readFileSync(filePath, 'utf8');

  return {
    source: `export default ${JSON.stringify(content)};`,
    format: 'module',
    shortCircuit: true,
  };
}
