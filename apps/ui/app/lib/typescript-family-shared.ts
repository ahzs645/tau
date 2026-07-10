/**
 * Shared lazy kernel typings, compiler defaults, and Automatic Type Acquisition (ATA)
 * for the split TS/JS language contributions (`typescript-contribution.ts`,
 * `javascript-contribution.ts`). Keeps a single refcounted ATA instance when both
 * families are active in one session.
 */

import type * as Monaco from 'monaco-editor';
import type { StaticTypeDefinition } from '#lib/type-acquisition-service.js';
import { TypeAcquisitionService } from '#lib/type-acquisition-service.js';
import { kernelTypeLoaders } from '@taucad/api-extractor/kernel-type-loaders';

/**
 * `ModuleResolutionKind.Bundler` from TypeScript 5.0+ (numeric value 100). Monaco's
 * public typings omit this enum member but the bundled language service supports it.
 */
const moduleResolutionBundler = 100 as Monaco.typescript.CompilerOptions['moduleResolution'];

const inlayHintsOptions = {
  includeInlayParameterNameHints: 'all',
  includeInlayParameterNameHintsWhenArgumentMatchesName: true,
} as const;

let ataInstance: TypeAcquisitionService | undefined;
let ataBootPromise: Promise<void> | undefined;
let ataRefCount = 0;

const builtinTypeLoaders = Object.fromEntries(
  Object.entries(kernelTypeLoaders).map(([packageName, load]) => [
    packageName,
    async (): Promise<readonly StaticTypeDefinition[]> =>
      Object.entries(await load()).map(([definitionPackageName, content]) => ({
        packageName: definitionPackageName,
        content,
        prewrapped: true,
      })),
  ]),
);

/**
 * Ensures ATA boots once; reference-counted so TS and JS contributions can each
 * `dispose()` their handle independently.
 */
export function ensureAtaBoot(monaco: typeof Monaco): Monaco.IDisposable {
  ataRefCount += 1;
  ataBootPromise ??= (async (): Promise<void> => {
    ataInstance = new TypeAcquisitionService();
    ataInstance.initialize(monaco, { builtinTypeLoaders });
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
  monaco.typescript.typescriptDefaults.setInlayHintsOptions(inlayHintsOptions);
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
  monaco.typescript.javascriptDefaults.setInlayHintsOptions(inlayHintsOptions);
}
