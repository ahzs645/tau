/**
 * Conversion utilities for LSP kinds to Monaco kinds.
 */

import type * as Monaco from 'monaco-editor';
import type * as LSP from 'vscode-languageserver-protocol';

/**
 * Build a map from LSP CompletionItemKind (1-25) to Monaco CompletionItemKind.
 */
const buildCompletionKindMap = (monaco: typeof Monaco): ReadonlyMap<number, Monaco.languages.CompletionItemKind> =>
  new Map<number, Monaco.languages.CompletionItemKind>([
    [1, monaco.languages.CompletionItemKind.Text],
    [2, monaco.languages.CompletionItemKind.Method],
    [3, monaco.languages.CompletionItemKind.Function],
    [4, monaco.languages.CompletionItemKind.Constructor],
    [5, monaco.languages.CompletionItemKind.Field],
    [6, monaco.languages.CompletionItemKind.Variable],
    [7, monaco.languages.CompletionItemKind.Class],
    [8, monaco.languages.CompletionItemKind.Interface],
    [9, monaco.languages.CompletionItemKind.Module],
    [10, monaco.languages.CompletionItemKind.Property],
    [11, monaco.languages.CompletionItemKind.Unit],
    [12, monaco.languages.CompletionItemKind.Value],
    [13, monaco.languages.CompletionItemKind.Enum],
    [14, monaco.languages.CompletionItemKind.Keyword],
    [15, monaco.languages.CompletionItemKind.Snippet],
    [16, monaco.languages.CompletionItemKind.Color],
    [17, monaco.languages.CompletionItemKind.File],
    [18, monaco.languages.CompletionItemKind.Reference],
    [19, monaco.languages.CompletionItemKind.Folder],
    [20, monaco.languages.CompletionItemKind.EnumMember],
    [21, monaco.languages.CompletionItemKind.Constant],
    [22, monaco.languages.CompletionItemKind.Struct],
    [23, monaco.languages.CompletionItemKind.Event],
    [24, monaco.languages.CompletionItemKind.Operator],
    [25, monaco.languages.CompletionItemKind.TypeParameter],
  ]);

let completionKindMap: ReadonlyMap<number, Monaco.languages.CompletionItemKind> | undefined;

/**
 * Convert LSP CompletionItemKind to Monaco CompletionItemKind.
 */
export function lspToMonacoCompletionKind(
  monaco: typeof Monaco,
  kind?: LSP.CompletionItemKind,
): Monaco.languages.CompletionItemKind {
  completionKindMap ??= buildCompletionKindMap(monaco);

  return completionKindMap.get(kind ?? -1) ?? monaco.languages.CompletionItemKind.Text;
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
