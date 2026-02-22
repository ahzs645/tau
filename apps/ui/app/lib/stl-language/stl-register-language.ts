import type * as Monaco from 'monaco-editor';
import { codeLanguages } from '@taucad/types/constants';
import type { LanguageContribution, ActivationContext, ActivationResult } from '#lib/monaco-language-registry.js';

/** Track if already registered to prevent duplicate registration */
let isRegistered = false;

/**
 * Register STL (Stereolithography) language with Monaco editor.
 *
 * This provides basic language support for ASCII STL files including:
 * - Language identification and configuration
 * - Syntax highlighting (via Shiki precompiled grammar)
 *
 * ASCII STL is a data format for describing 3D triangulated surfaces.
 * It has no comment syntax, no strings, and no bracket structures.
 *
 * @see https://en.wikipedia.org/wiki/STL_(file_format)
 * @see https://microsoft.github.io/monaco-editor/playground.html#extending-language-services-custom-languages
 */
export function registerStlLanguage(monaco: typeof Monaco): void {
  if (isRegistered) {
    return;
  }

  isRegistered = true;

  monaco.languages.register({
    id: codeLanguages.stl,
    extensions: ['.stl'],
    aliases: ['STL', 'stl'],
    mimetypes: ['text/x-stl'],
  });

  // ASCII STL has no comment syntax, no strings, and no brackets.
  // Provide folding markers for solid/endsolid and facet/endfacet blocks.
  monaco.languages.setLanguageConfiguration(codeLanguages.stl, {
    folding: {
      markers: {
        start: /^\s*(solid|facet)\b/,
        end: /^\s*(endsolid|endfacet)\b/,
      },
    },
  });
}

// ============================================================================
// Language Contribution (for LanguageContributionRegistry)
// ============================================================================

/**
 * STL (Stereolithography) Language Contribution
 *
 * Conforms to the LanguageContribution interface for uniform lifecycle management.
 * STL is a read-only geometry data format -- all providers are registered during
 * the register phase since they don't depend on external services.
 */
export const stlContribution: LanguageContribution = {
  languageId: codeLanguages.stl,

  register(monaco: typeof Monaco): void {
    registerStlLanguage(monaco);
  },

  activate(_context: ActivationContext): ActivationResult {
    return {
      disposables: [],
    };
  },

  dispose(): void {
    isRegistered = false;
  },
};
