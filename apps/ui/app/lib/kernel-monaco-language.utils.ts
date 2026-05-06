/**
 * Kernel ↔ Monaco language mapping utilities used by the LSP prefetch hook in
 * `MonacoModelServiceProvider`. Maps a runtime kernel id (the value emitted by
 * `cadMachine.activeKernelChanged`) to the set of Monaco language ids whose
 * contributions should be warmed up.
 *
 * Derived from the registered kernel plugin list, since the runtime
 * `CapabilitiesManifest` only carries export-route metadata — it does not
 * expose per-kernel source-file extensions.
 */

import { kernelSourceExtensionsById } from '#constants/kernel-monaco-extensions.constants.js';
import type { MonacoLanguage } from '#lib/monaco.constants.js';
import { extensionToMonacoLanguage } from '#lib/monaco.constants.js';

const kernelExtensionsById = new Map<string, readonly string[]>(Object.entries(kernelSourceExtensionsById));

/**
 * Resolve the Monaco language ids associated with a kernel id. Returns an
 * empty array when the kernel id is unknown or none of its extensions map to
 * a Monaco language.
 */
export function getMonacoLanguageIdsForKernel(kernelId: string): MonacoLanguage[] {
  const extensions = kernelExtensionsById.get(kernelId);
  if (!extensions) {
    return [];
  }

  const monacoIds = new Set<MonacoLanguage>();
  for (const extension of extensions) {
    const id = extensionToMonacoLanguage[extension];
    if (id) {
      monacoIds.add(id);
    }
  }
  return [...monacoIds];
}
