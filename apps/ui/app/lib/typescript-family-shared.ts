/**
 * Shared kernel typings, compiler defaults, and Automatic Type Acquisition (ATA)
 * for the split TS/JS language contributions (`typescript-contribution.ts`,
 * `javascript-contribution.ts`). Keeps a single refcounted ATA instance when both
 * families are active in one session.
 */

import type * as Monaco from 'monaco-editor';
import { kernelTypeMaps } from '@taucad/api-extractor';
import type { FileManagerRef, FileManagerProxy } from '#machines/file-manager.machine.types.js';
import type { StaticTypeDefinition } from '#lib/type-acquisition-service.js';
import { TypeAcquisitionService } from '#lib/type-acquisition-service.js';

/**
 * `ModuleResolutionKind.Bundler` from TypeScript 5.0+ (numeric value 100). Monaco's
 * public typings omit this enum member but the bundled language service supports it.
 */
const moduleResolutionBundler = 100 as Monaco.typescript.CompilerOptions['moduleResolution'];

let ataInstance: TypeAcquisitionService | undefined;
let ataBootPromise: Promise<void> | undefined;
let ataRefCount = 0;

/**
 * Prefer typings bytes from the FM worker `/node_modules` mount; fall back to
 * bundled {@link kernelTypeMaps} when the mount is not ready or read fails.
 *
 * @public
 */
export async function loadKernelStaticTypesFromMount(
  proxy: FileManagerProxy | undefined,
): Promise<StaticTypeDefinition[]> {
  const fallback: StaticTypeDefinition[] = kernelTypeMaps.flatMap((typesMap) =>
    Object.entries(typesMap).map(([packageName, content]) => ({
      packageName,
      content,
      prewrapped: true,
    })),
  );

  if (!proxy) {
    return fallback;
  }

  return Promise.all(
    fallback.map(async (staticTypeDefinition) => {
      try {
        const bytes = await proxy.readFile(`/node_modules/${staticTypeDefinition.packageName}/index.d.ts`);
        const content = new TextDecoder().decode(bytes);
        return { packageName: staticTypeDefinition.packageName, content, prewrapped: true };
      } catch {
        return staticTypeDefinition;
      }
    }),
  );
}

/**
 * Ensures ATA boots once; reference-counted so TS and JS contributions can each
 * `dispose()` their handle independently.
 */
export function ensureAtaBoot(monaco: typeof Monaco, fileManagerRef: FileManagerRef): Monaco.IDisposable {
  ataRefCount += 1;
  ataBootPromise ??= (async (): Promise<void> => {
    const {
      context: { proxy },
    } = fileManagerRef.getSnapshot();
    const staticTypes = await loadKernelStaticTypesFromMount(proxy);
    ataInstance = new TypeAcquisitionService();
    ataInstance.initialize(monaco, { staticTypes });
    ataInstance.startWatching();
  })();

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      // async-iife: bootstrap
      void (async (): Promise<void> => {
        try {
          await ataBootPromise;
        } finally {
          ataRefCount -= 1;
          if (ataRefCount <= 0) {
            ataInstance?.dispose();
            ataInstance = undefined;
            ataBootPromise = undefined;
            ataRefCount = 0;
          }
        }
      })();
    },
  };
}

/** Forward project session change to the live ATA singleton (if any). */
export function forwardAtaProjectSessionChange(_projectId: string): void {
  ataInstance?.onProjectSessionChange();
}

export function setTsCompilerOptions(monaco: typeof Monaco): void {
  monaco.typescript.typescriptDefaults.setCompilerOptions({
    experimentalDecorators: true,
    allowSyntheticDefaultImports: true,
    allowImportingTsExtensions: true,
    moduleResolution: moduleResolutionBundler,
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    noLib: false,
    allowNonTsExtensions: true,
    noEmit: true,
    esModuleInterop: true,
    baseUrl: '.',
  });
}

export function setJsCompilerOptions(monaco: typeof Monaco): void {
  monaco.typescript.javascriptDefaults.setCompilerOptions({
    allowSyntheticDefaultImports: true,
    moduleResolution: moduleResolutionBundler,
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    allowJs: true,
    checkJs: true,
    esModuleInterop: true,
  });
}
