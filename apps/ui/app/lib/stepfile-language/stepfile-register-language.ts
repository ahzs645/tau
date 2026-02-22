import type * as Monaco from 'monaco-editor';
import { codeLanguages } from '@taucad/types/constants';
import type { LanguageContribution, ActivationContext, ActivationResult } from '#lib/monaco-language-registry.js';

/** Track if already registered to prevent duplicate registration */
let isRegistered = false;

/**
 * Register STEP file language with Monaco editor.
 *
 * This provides basic language support for STEP (ISO 10303-21) files including:
 * - Language identification and configuration
 * - Syntax highlighting (via Shiki precompiled grammar)
 *
 * @see https://microsoft.github.io/monaco-editor/playground.html#extending-language-services-custom-languages
 */
export function registerStepfileLanguage(monaco: typeof Monaco): void {
  if (isRegistered) {
    return;
  }

  isRegistered = true;

  monaco.languages.register({
    id: codeLanguages.stepfile,
    extensions: ['.step', '.stp', '.p21'],
    aliases: ['STEP', 'stepfile'],
    mimetypes: ['text/x-step'],
  });

  monaco.languages.setLanguageConfiguration(codeLanguages.stepfile, {
    comments: {
      blockComment: ['/*', '*/'],
    },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '/*', close: '*/' },
      { open: "'", close: "'", notIn: ['string', 'comment'] },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: "'", close: "'" },
    ],
  });
}

// ============================================================================
// Language Contribution (for LanguageContributionRegistry)
// ============================================================================

/**
 * STEP File Language Contribution
 *
 * Conforms to the LanguageContribution interface for uniform lifecycle management.
 * STEP files are read-only geometry files -- all providers are registered during
 * the register phase since they don't depend on external services.
 */
export const stepfileContribution: LanguageContribution = {
  languageId: codeLanguages.stepfile,

  register(monaco: typeof Monaco): void {
    registerStepfileLanguage(monaco);
  },

  activate(_context: ActivationContext): ActivationResult {
    // STEP file providers are already registered during register phase
    // No additional activation needed (no LSP, no navigation handler)
    return {
      disposables: [],
    };
  },

  dispose(): void {
    isRegistered = false;
  },
};
