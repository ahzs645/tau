/**
 * Conversion utilities for LSP kinds to Monaco kinds.
 */

import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type * as LSP from 'vscode-languageserver-protocol';

/**
 * Convert LSP CompletionItemKind to Monaco CompletionItemKind.
 */
export function lspToMonacoCompletionKind(
  monaco: typeof Monaco,
  kind?: LSP.CompletionItemKind,
): Monaco.languages.CompletionItemKind {
  if (kind === undefined) {
    return monaco.languages.CompletionItemKind.Text;
  }

  // LSP CompletionItemKind values: 1-25
  switch (kind) {
    case 1: {
      return monaco.languages.CompletionItemKind.Text;
    }

    case 2: {
      return monaco.languages.CompletionItemKind.Method;
    }

    case 3: {
      return monaco.languages.CompletionItemKind.Function;
    }

    case 4: {
      return monaco.languages.CompletionItemKind.Constructor;
    }

    case 5: {
      return monaco.languages.CompletionItemKind.Field;
    }

    case 6: {
      return monaco.languages.CompletionItemKind.Variable;
    }

    case 7: {
      return monaco.languages.CompletionItemKind.Class;
    }

    case 8: {
      return monaco.languages.CompletionItemKind.Interface;
    }

    case 9: {
      return monaco.languages.CompletionItemKind.Module;
    }

    case 10: {
      return monaco.languages.CompletionItemKind.Property;
    }

    case 11: {
      return monaco.languages.CompletionItemKind.Unit;
    }

    case 12: {
      return monaco.languages.CompletionItemKind.Value;
    }

    case 13: {
      return monaco.languages.CompletionItemKind.Enum;
    }

    case 14: {
      return monaco.languages.CompletionItemKind.Keyword;
    }

    case 15: {
      return monaco.languages.CompletionItemKind.Snippet;
    }

    case 16: {
      return monaco.languages.CompletionItemKind.Color;
    }

    case 17: {
      return monaco.languages.CompletionItemKind.File;
    }

    case 18: {
      return monaco.languages.CompletionItemKind.Reference;
    }

    case 19: {
      return monaco.languages.CompletionItemKind.Folder;
    }

    case 20: {
      return monaco.languages.CompletionItemKind.EnumMember;
    }

    case 21: {
      return monaco.languages.CompletionItemKind.Constant;
    }

    case 22: {
      return monaco.languages.CompletionItemKind.Struct;
    }

    case 23: {
      return monaco.languages.CompletionItemKind.Event;
    }

    case 24: {
      return monaco.languages.CompletionItemKind.Operator;
    }

    case 25: {
      return monaco.languages.CompletionItemKind.TypeParameter;
    }

    default: {
      return monaco.languages.CompletionItemKind.Text;
    }
  }
}

/**
 * Convert LSP SymbolKind to Monaco SymbolKind.
 */
export function lspToMonacoSymbolKind(_monaco: typeof Monaco, kind: LSP.SymbolKind): Monaco.languages.SymbolKind {
  // LSP and Monaco symbol kinds are aligned
  return kind as Monaco.languages.SymbolKind;
}

/**
 * Convert LSP FoldingRangeKind to Monaco FoldingRangeKind.
 */
export function lspToMonacoFoldingRangeKind(
  monaco: typeof Monaco,
  kind?: LSP.FoldingRangeKind,
): Monaco.languages.FoldingRangeKind | undefined {
  if (kind === undefined) {
    return undefined;
  }

  switch (kind) {
    case 'comment': {
      return monaco.languages.FoldingRangeKind.Comment;
    }

    case 'imports': {
      return monaco.languages.FoldingRangeKind.Imports;
    }

    case 'region': {
      return monaco.languages.FoldingRangeKind.Region;
    }

    default: {
      return undefined;
    }
  }
}

/**
 * Format documentation from LSP MarkupContent or string to Monaco IMarkdownString.
 */
export function formatDocumentation(
  documentation: string | LSP.MarkupContent | undefined,
): Monaco.IMarkdownString | string | undefined {
  if (documentation === undefined) {
    return undefined;
  }

  if (typeof documentation === 'string') {
    return documentation;
  }

  // MarkupContent
  if (documentation.kind === 'markdown') {
    return { value: documentation.value };
  }

  return documentation.value;
}
