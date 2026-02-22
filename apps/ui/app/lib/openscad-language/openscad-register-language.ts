// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import type * as Monaco from 'monaco-editor';
import { codeLanguages } from '@taucad/types/constants';
import { createCompletionItemProvider } from '#lib/openscad-language/openscad-completions.js';
import { createDefinitionProvider } from '#lib/openscad-language/openscad-definition.js';
import { createHoverProvider } from '#lib/openscad-language/openscad-hover.js';
import { createOpenscadLanguageConfiguration } from '#lib/openscad-language/openscad-language.js';
import { createSignatureHelpProvider } from '#lib/openscad-language/openscad-signature-help.js';
import type { LanguageContribution, ActivationContext, ActivationResult } from '#lib/monaco-language-registry.js';

/** Track if already registered to prevent duplicate registration */
let isRegistered = false;

// https://microsoft.github.io/monaco-editor/playground.html#extending-language-services-custom-languages
export function registerOpenScadLanguage(monaco: typeof Monaco): void {
  if (isRegistered) {
    return;
  }

  isRegistered = true;

  monaco.languages.register({
    id: codeLanguages.openscad,
    extensions: ['.scad'],
    aliases: ['OpenSCAD', 'openscad'],
    mimetypes: ['text/x-openscad'],
  });

  // Create the language configuration and definition with monaco injection
  const languageConfiguration = createOpenscadLanguageConfiguration(monaco);
  const completionProvider = createCompletionItemProvider(monaco);

  monaco.languages.setLanguageConfiguration('openscad', languageConfiguration);
  monaco.languages.registerCompletionItemProvider('openscad', completionProvider);
  monaco.languages.registerHoverProvider('openscad', createHoverProvider(monaco));
  monaco.languages.registerSignatureHelpProvider('openscad', createSignatureHelpProvider(monaco));

  // Register definition provider for Go to Definition (Cmd/Ctrl+click)
  monaco.languages.registerDefinitionProvider('openscad', createDefinitionProvider(monaco));
}

// ============================================================================
// Language Contribution (for LanguageContributionRegistry)
// ============================================================================

/**
 * OpenSCAD Language Contribution
 *
 * Conforms to the LanguageContribution interface for uniform lifecycle management.
 * OpenSCAD is simple -- all providers are registered during the register phase
 * since they don't depend on external services.
 */
export const openscadContribution: LanguageContribution = {
  languageId: codeLanguages.openscad,

  register(monaco: typeof Monaco): void {
    registerOpenScadLanguage(monaco);
  },

  activate(_context: ActivationContext): ActivationResult {
    // OpenSCAD providers are already registered during register phase
    // No additional activation needed (no LSP, no navigation handler)
    return {
      disposables: [],
    };
  },

  dispose(): void {
    isRegistered = false;
  },
};
