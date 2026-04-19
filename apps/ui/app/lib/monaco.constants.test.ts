import { describe, it, expect } from 'vitest';
import { languageFromExtension } from '@taucad/types/constants';
import { extensionToMonacoLanguage, monacoLanguages } from '#lib/monaco.constants.js';

describe('JSON-family language mappings', () => {
  describe('jsonl', () => {
    it('should map to a distinct language from json so the JSON validator does not flag multi-root documents', () => {
      expect(languageFromExtension.jsonl).not.toBe(languageFromExtension.json);
      expect(languageFromExtension.jsonl).toBe('jsonl');
    });

    it('should have a dedicated Monaco language ID separate from json', () => {
      expect(extensionToMonacoLanguage['jsonl']).toBe(monacoLanguages.jsonl);
      expect(monacoLanguages.jsonl).not.toBe(monacoLanguages.json);
    });
  });

  describe('jsonc', () => {
    it('should map to the jsonc language that allows comments without diagnostics errors', () => {
      expect(languageFromExtension.jsonc).toBe('jsonc');
    });

    it('should have a dedicated Monaco language ID for JSON with Comments', () => {
      expect(extensionToMonacoLanguage['jsonc']).toBe(monacoLanguages.jsonc);
      expect(monacoLanguages.jsonc).toBe('jsonc');
    });

    it('should be distinct from plain json so comment syntax is not flagged', () => {
      expect(monacoLanguages.jsonc).not.toBe(monacoLanguages.json);
      expect(languageFromExtension.jsonc).not.toBe(languageFromExtension.json);
    });
  });

  describe('json', () => {
    it('should remain unchanged as strict json', () => {
      expect(languageFromExtension.json).toBe('json');
      expect(extensionToMonacoLanguage['json']).toBe('json');
    });
  });
});
