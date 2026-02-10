/**
 * JavaScript Definition Provider
 *
 * Implements Monaco's DefinitionProvider for Cmd+Click navigation on imports.
 * Uses cached es-module-lexer parsing for performance.
 *
 * Uses root-level Monaco URIs (e.g., file:///main.ts) for consistent module resolution.
 */

import type * as Monaco from 'monaco-editor';
import { getImportAtPosition } from '#lib/javascript-import-parser.js';
import type { ModuleResolver } from '#lib/javascript-module-resolver.js';

type JsDefinitionProviderOptions = {
  resolver: ModuleResolver;
};

/**
 * Create a DefinitionProvider for JavaScript/TypeScript files that handles
 * Cmd+Click on import statements to navigate to the imported module.
 *
 * @param monaco - The Monaco instance
 * @param options - Provider options including resolver
 * @returns A DefinitionProvider instance
 */
export function createJsDefinitionProvider(
  monaco: typeof Monaco,
  options: JsDefinitionProviderOptions,
): Monaco.languages.DefinitionProvider {
  const { resolver } = options;

  return {
    async provideDefinition(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
    ): Promise<Monaco.languages.LocationLink[] | undefined> {
      // 1. Get import at cursor using cached parse results
      const importInfo = await getImportAtPosition(model, position);
      if (!importInfo) {
        return undefined;
      }

      // 2. Extract current file path from root-level Monaco URI
      // URI path is like /main.ts or /lib/utils.ts
      const uriPath = model.uri.path;
      const currentFilePath = uriPath.startsWith('/') ? uriPath.slice(1) : uriPath;

      // 3. Resolve the module
      const result = await resolver.resolveModule(importInfo.specifier, currentFilePath);
      if (!result) {
        return undefined;
      }

      // 4. Skip CDN URLs (no local file to navigate to)
      if (result.isCdn) {
        return undefined;
      }

      // 5. Calculate the origin selection range (what to highlight in source)
      // Convert character offsets to line/column positions for the full specifier
      const startPosition = model.getPositionAt(importInfo.startOffset);
      const endPosition = model.getPositionAt(importInfo.endOffset);
      const originSelectionRange = new monaco.Range(
        startPosition.lineNumber,
        startPosition.column,
        endPosition.lineNumber,
        endPosition.column,
      );

      // 6. Return LocationLink[] with originSelectionRange for full specifier highlighting
      return [
        {
          originSelectionRange,
          uri: monaco.Uri.file(result.resolvedPath),
          range: new monaco.Range(1, 1, 1, 1),
          targetSelectionRange: new monaco.Range(1, 1, 1, 1),
        },
      ];
    },
  };
}
