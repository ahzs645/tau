import type * as Monaco from 'monaco-editor';
import { codeLanguages } from '@taucad/types/constants';
import type { LanguageContribution, ActivationContext, ActivationResult } from '#lib/monaco-language-registry.js';

/** Track if already registered to prevent duplicate registration */
let isRegistered = false;

/**
 * Register USD (Universal Scene Description) language with Monaco editor.
 *
 * This provides basic language support for USD files including:
 * - Language identification and configuration
 * - Syntax highlighting (via Shiki precompiled grammar)
 *
 * @see https://microsoft.github.io/monaco-editor/playground.html#extending-language-services-custom-languages
 */
export function registerUsdLanguage(monaco: typeof Monaco): void {
  if (isRegistered) {
    return;
  }

  isRegistered = true;

  monaco.languages.register({
    id: codeLanguages.usd,
    extensions: ['.usd', '.usda', '.usdc', '.usdz'],
    aliases: ['USD', 'usd'],
    mimetypes: ['text/x-usd'],
  });

  monaco.languages.setLanguageConfiguration(codeLanguages.usd, {
    comments: {
      lineComment: '#',
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
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: '@', close: '@' },
      { open: '<', close: '>' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: '@', close: '@' },
      { open: '<', close: '>' },
    ],
  });
}

// ============================================================================
// Language Contribution (for LanguageContributionRegistry)
// ============================================================================

/**
 * USD Language Contribution
 *
 * Conforms to the LanguageContribution interface for uniform lifecycle management.
 * USD is a simple language -- all providers are registered during the register phase
 * since they don't depend on external services.
 */
export const usdContribution: LanguageContribution = {
  languageId: codeLanguages.usd,

  register(monaco: typeof Monaco): void {
    registerUsdLanguage(monaco);
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
