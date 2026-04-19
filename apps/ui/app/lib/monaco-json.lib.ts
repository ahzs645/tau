import type { StateStack } from 'shiki/textmate';
import type * as Monaco from 'monaco-editor';

/**
 * Minimal grammar interface for JSON tokenization.
 *
 * Matches the subset of vscode-textmate's `IGrammar` used by the
 * depth-aware JSON tokenizer.
 */
type JsonGrammar = {
  tokenizeLine(
    line: string,
    // oxlint-disable-next-line typescript-eslint/no-restricted-types -- vscode-textmate's tokenizeLine API requires null
    previousState: StateStack | null,
  ): {
    tokens: Array<{ startIndex: number; scopes: string[] }>;
    ruleStack: StateStack;
  };
};

/**
 * Structural subset of Shiki's `ThemeRegistrationResolved` used to
 * extract scope colors for JSON colorization.
 */
type ShikiTheme = {
  fg: string;
  settings: ReadonlyArray<{
    scope?: string | string[];
    settings: { foreground?: string };
  }>;
  colors?: Readonly<Record<string, string>>;
};

/**
 * Monaco `IState` wrapper for vscode-textmate's `StateStack`.
 *
 * Bridges Shiki's grammar state with Monaco's tokenizer state interface,
 * allowing per-line incremental tokenization with object nesting depth.
 */
class JsonTokenizerState implements Monaco.languages.IState {
  // oxlint-disable typescript-eslint/parameter-properties -- tsgo erasableSyntaxOnly forbids constructor parameter properties
  public ruleStack: StateStack | undefined;
  public depth: number;
  // oxlint-enable typescript-eslint/parameter-properties
  public constructor(ruleStack: StateStack | undefined, depth = 0) {
    this.ruleStack = ruleStack;
    this.depth = depth;
  }
  public clone() {
    return new JsonTokenizerState(this.ruleStack, this.depth);
  }
  public equals(other: Monaco.languages.IState) {
    return other instanceof JsonTokenizerState && other.ruleStack === this.ruleStack && other.depth === this.depth;
  }
}

/**
 * TextMate scopes whose foreground colors are used for each key depth level.
 *
 * Ordered so that the first 4 scopes (depths 0-3, the most common in real
 * JSON) never collide with any value color (string green, number orange,
 * boolean blue). The last 3 scopes reuse value-colored scopes but only
 * appear at depths 4+, which are rare in practice.
 *
 * GitHub Dark palette:
 *   purple → light-blue → coral (overridden) → pink → blue → green → orange
 */
const keyDepthScopes = [
  'entity.name',
  'string',
  'string.regexp',
  'keyword',
  'support.type.property-name',
  'entity.name.tag',
  'variable',
] as const;

const depthCycleLength = keyDepthScopes.length;

const jsonKeyScopes = ['support.type.property-name.json'] as const;

const tmBracketBeginScope = 'punctuation.definition.dictionary.begin.json';
const tmBracketEndScope = 'punctuation.definition.dictionary.end.json';

const jsonQuoteScopes = [
  'punctuation.support.type.property-name.begin.json',
  'punctuation.support.type.property-name.end.json',
  'punctuation.definition.string.begin.json',
  'punctuation.definition.string.end.json',
] as const;

/**
 * Resolve the foreground color for a TextMate scope from a Shiki theme.
 *
 * Uses longest-prefix matching at dot boundaries, falling back to the
 * theme's default foreground when no rule matches.
 */
const resolveThemeColor = (theme: ShikiTheme, targetScope: string): string => {
  let bestLength = 0;
  let color = theme.fg;

  for (const entry of theme.settings) {
    const { foreground } = entry.settings;
    if (!foreground) {
      continue;
    }

    const scopes = typeof entry.scope === 'string' ? [entry.scope] : (entry.scope ?? []);

    for (const selector of scopes) {
      const isMatch = targetScope === selector || targetScope.startsWith(`${selector}.`);

      if (isMatch && selector.length > bestLength) {
        bestLength = selector.length;
        color = foreground;
      }
    }
  }

  return color;
};

const stripHash = (color: string) => color.replace('#', '');

/**
 * Generate `editorBracketHighlight.foreground*` overrides for the Monaco
 * theme colors map.
 *
 * Uses yellow, pink, and blue — no purple. All three colors are derived
 * from the theme: yellow from `terminal.ansiYellow`, pink from the
 * `invalid.broken` token scope (soft pastel pink), and blue from
 * `terminal.ansiBlue`.
 *
 * @param theme - A resolved Shiki theme (from `highlighter.getTheme()`).
 */
export const generateJsonBracketHighlightColors = (theme: ShikiTheme): Record<string, string> => {
  const yellow = theme.colors?.['terminal.ansiYellow'] ?? resolveThemeColor(theme, 'variable');
  const pink = resolveThemeColor(theme, 'invalid.broken');
  const blue = theme.colors?.['terminal.ansiBlue'] ?? resolveThemeColor(theme, 'constant');
  const bracketColors = [yellow, pink, blue];
  return Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [`editorBracketHighlight.foreground${i + 1}`, bracketColors[i % 3]!]),
  );
};

/**
 * Generate Monaco theme rules for JSON colorization from a Shiki theme.
 *
 * Extracts foreground colors from the theme for key depth scopes
 * ({@link keyDepthScopes}) and JSON value types. All colors are derived
 * from the theme — nothing is hardcoded.
 *
 * @param theme - A resolved Shiki theme (from `highlighter.getTheme()`).
 */
export const generateJsonThemeRules = (theme: ShikiTheme): Monaco.editor.ITokenThemeRule[] => {
  const depthColors = keyDepthScopes.map((scope) => stripHash(resolveThemeColor(theme, scope)));
  // String.regexp (#dbedff) is too pale on dark backgrounds; use the theme's accent orange instead
  depthColors[2] = stripHash(theme.colors?.['tab.activeBorderTop'] ?? resolveThemeColor(theme, 'string.regexp'));

  const stringColor = stripHash(resolveThemeColor(theme, 'entity.name.tag'));
  const numberColor = stripHash(resolveThemeColor(theme, 'variable'));
  const booleanColor = stripHash(resolveThemeColor(theme, 'constant'));

  const defaultColor = stripHash(theme.fg);

  return [
    ...jsonKeyScopes.flatMap((keyScope) =>
      depthColors.map((foreground, depth) => ({
        token: `${keyScope}.depth${depth}`,
        foreground,
      })),
    ),
    ...jsonQuoteScopes.map((token) => ({ token, foreground: defaultColor })),
    { token: 'string.quoted.double.json', foreground: stringColor },
    { token: 'constant.numeric.json', foreground: numberColor },
    { token: 'constant.language.json', foreground: booleanColor },
  ];
};

/**
 * Create a Monaco tokens provider for JSON with depth-based key colorization.
 *
 * Tracks object nesting depth (`{`/`}`) across lines and maps key scopes
 * to depth-specific variants so theme rules can assign distinct colors
 * per nesting level. The depth cycles every {@link depthCycleLength} levels.
 *
 * @param grammar - A TextMate grammar for JSON (from Shiki's highlighter).
 */
export const createJsonTokensProvider = (grammar: JsonGrammar): Monaco.languages.TokensProvider => ({
  getInitialState: () => new JsonTokenizerState(undefined),
  tokenize(line, state) {
    const { ruleStack, depth: stateDepth } = state as JsonTokenizerState;
    const result = grammar.tokenizeLine(line, ruleStack ?? null);
    let depth = stateDepth;

    const tokens = result.tokens.map((t) => {
      const scope = t.scopes.at(-1) ?? '';

      if (scope === tmBracketBeginScope) {
        depth++;
        return { startIndex: t.startIndex, scopes: scope };
      }

      if (scope === tmBracketEndScope) {
        depth = Math.max(0, depth - 1);
        return { startIndex: t.startIndex, scopes: scope };
      }

      const isKey = scope === 'support.type.property-name.json';

      return {
        startIndex: t.startIndex,
        scopes: isKey ? `${scope}.depth${depth > 0 ? (depth - 1) % depthCycleLength : 0}` : scope,
      };
    });

    return {
      endState: new JsonTokenizerState(result.ruleStack, depth),
      tokens,
    };
  },
});
