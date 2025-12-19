/**
 * Position conversion utilities between Monaco (1-based) and LSP (0-based).
 */

import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type * as LSP from 'vscode-languageserver-protocol';

/**
 * Convert Monaco Position (1-based) to LSP Position (0-based).
 */
export function monacoToLspPosition(position: Monaco.Position): LSP.Position {
  return {
    line: position.lineNumber - 1,
    character: position.column - 1,
  };
}

/**
 * Convert LSP Position (0-based) to Monaco Position (1-based).
 */
export function lspToMonacoPosition(monaco: typeof Monaco, position: LSP.Position): Monaco.Position {
  return new monaco.Position(position.line + 1, position.character + 1);
}

/**
 * Convert LSP Range to Monaco Range.
 */
export function lspToMonacoRange(monaco: typeof Monaco, range: LSP.Range): Monaco.Range {
  return new monaco.Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1);
}

/**
 * Convert Monaco Range to LSP Range.
 */
export function monacoToLspRange(range: Monaco.IRange): LSP.Range {
  return {
    start: {
      line: range.startLineNumber - 1,
      character: range.startColumn - 1,
    },
    end: {
      line: range.endLineNumber - 1,
      character: range.endColumn - 1,
    },
  };
}

/**
 * Convert LSP DiagnosticSeverity to Monaco MarkerSeverity.
 */
export function lspSeverityToMonaco(monaco: typeof Monaco, severity?: LSP.DiagnosticSeverity): Monaco.MarkerSeverity {
  switch (severity) {
    case 1: {
      return monaco.MarkerSeverity.Error;
    }

    case 2: {
      return monaco.MarkerSeverity.Warning;
    }

    case 3: {
      return monaco.MarkerSeverity.Info;
    }

    case 4: {
      return monaco.MarkerSeverity.Hint;
    }

    default: {
      return monaco.MarkerSeverity.Error;
    }
  }
}
