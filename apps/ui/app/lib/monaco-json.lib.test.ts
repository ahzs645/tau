/* eslint-disable @typescript-eslint/naming-convention -- test names */
import { describe, it, expect } from 'vitest';
import type { StateStack } from 'shiki/textmate';
import {
  generateJsonThemeRules,
  generateJsonBracketHighlightColors,
  createJsonTokensProvider,
} from '#lib/monaco-json.lib.js';

const mockTheme = {
  fg: '#e1e4e8',
  settings: [
    { scope: 'support.type.property-name', settings: { foreground: '#79b8ff' } },
    { scope: 'entity.name', settings: { foreground: '#b392f0' } },
    { scope: 'entity.name.tag', settings: { foreground: '#85e89d' } },
    { scope: 'variable', settings: { foreground: '#ffab70' } },
    { scope: 'keyword', settings: { foreground: '#f97583' } },
    { scope: 'string', settings: { foreground: '#9ecbff' } },
    { scope: 'string.regexp', settings: { foreground: '#dbedff' } },
    { scope: 'constant', settings: { foreground: '#79b8ff' } },
    { scope: 'invalid.broken', settings: { foreground: '#fdaeb7' } },
  ],
  colors: {
    'terminal.ansiYellow': '#ffea7f',
    'terminal.ansiBlue': '#2188ff',
    'tab.activeBorderTop': '#f9826c',
  },
};

const bracketColorHexValues = ['ffea7f', 'fdaeb7', '2188ff'];

const tmBracketBegin = 'punctuation.definition.dictionary.begin.json';
const tmBracketEnd = 'punctuation.definition.dictionary.end.json';
const tmKeyScope = 'support.type.property-name.json';

const createMockGrammar = (lineDefinitions: Array<Array<{ text: string; scope: string }>>) => {
  let lineIndex = 0;
  const ruleStack = {} as unknown as StateStack;
  return {
    // oxlint-disable-next-line typescript-eslint/no-restricted-types -- matches vscode-textmate's tokenizeLine API
    tokenizeLine(_line: string, _previous: StateStack | null) {
      const segments = lineDefinitions[lineIndex] ?? [];
      lineIndex++;
      let offset = 0;
      const tokens = segments.map((seg) => {
        const token = { startIndex: offset, scopes: [seg.scope] };
        offset += seg.text.length;
        return token;
      });
      return { tokens, ruleStack };
    },
  };
};

describe('generateJsonThemeRules', () => {
  const rules = generateJsonThemeRules(mockTheme);
  const ruleMap = new Map(rules.map((r) => [r.token, r.foreground]));

  it('generates key depth rules that cycle through 7 distinct colors', () => {
    const keyColors = Array.from({ length: 7 }, (_, i) => ruleMap.get(`${tmKeyScope}.depth${i}`));

    for (const color of keyColors) {
      expect(color).toBeDefined();
    }

    expect(new Set(keyColors).size).toBe(7);
  });

  it('generates bracket highlight colors: yellow, pink, blue (no purple)', () => {
    const colors = generateJsonBracketHighlightColors(mockTheme);
    const values = Object.values(colors);

    expect(values).toHaveLength(6);
    expect(colors['editorBracketHighlight.foreground1']).toBe('#ffea7f');
    expect(colors['editorBracketHighlight.foreground2']).toBe('#fdaeb7');
    expect(colors['editorBracketHighlight.foreground3']).toBe('#2188ff');
    // Cycle repeats
    expect(colors['editorBracketHighlight.foreground4']).toBe('#ffea7f');

    const purple = '#DA70D6';
    for (const color of values) {
      expect(color.toLowerCase()).not.toBe(purple.toLowerCase());
    }
  });

  it('generates quote rules with default foreground', () => {
    const defaultColor = mockTheme.fg.replace('#', '');
    const quoteScopes = [
      'punctuation.support.type.property-name.begin.json',
      'punctuation.support.type.property-name.end.json',
      'punctuation.definition.string.begin.json',
      'punctuation.definition.string.end.json',
    ];

    for (const scope of quoteScopes) {
      expect(ruleMap.get(scope)).toBe(defaultColor);
    }
  });

  it('uses light blue for boolean/null (constant scope, not keyword)', () => {
    const booleanColor = ruleMap.get('constant.language.json');
    const keywordColor = mockTheme.settings.find((s) => s.scope === 'keyword')!.settings.foreground.replace('#', '');
    const constantColor = mockTheme.settings.find((s) => s.scope === 'constant')!.settings.foreground.replace('#', '');

    expect(booleanColor).toBe(constantColor);
    expect(booleanColor).not.toBe(keywordColor);
  });

  it('primitive value colors do not collide with bracket highlight colors', () => {
    const primitiveColors = [
      ruleMap.get('string.quoted.double.json'),
      ruleMap.get('constant.numeric.json'),
      ruleMap.get('constant.language.json'),
    ];

    for (const primitiveColor of primitiveColors) {
      expect(primitiveColor).toBeDefined();
      for (const bracketColor of bracketColorHexValues) {
        expect(primitiveColor!.toLowerCase()).not.toBe(bracketColor.toLowerCase());
      }
    }
  });

  it('key colors at depths 0-3 never match any primitive value color', () => {
    const valueColors = [
      ruleMap.get('string.quoted.double.json')!,
      ruleMap.get('constant.numeric.json')!,
      ruleMap.get('constant.language.json')!,
    ];
    const shallowKeyColors = Array.from({ length: 4 }, (_, i) => ruleMap.get(`${tmKeyScope}.depth${i}`)!);

    for (const keyColor of shallowKeyColors) {
      for (const valueColor of valueColors) {
        expect(keyColor.toLowerCase()).not.toBe(valueColor.toLowerCase());
      }
    }
  });
});

describe('createJsonTokensProvider', () => {
  it('applies depth-based key scopes cycling over 7 levels and passes brackets through unchanged', () => {
    const grammar = createMockGrammar([
      // Depth 0 → 1
      [{ text: '{', scope: tmBracketBegin }],
      // Key at depth 1 (index 0)
      [
        { text: '"', scope: 'punctuation.support.type.property-name.begin.json' },
        { text: 'a', scope: tmKeyScope },
        { text: '"', scope: 'punctuation.support.type.property-name.end.json' },
        { text: ':', scope: 'punctuation.separator.dictionary.key-value.json' },
        { text: '{', scope: tmBracketBegin },
      ],
      // Key at depth 2 (index 1)
      [
        { text: '"', scope: 'punctuation.support.type.property-name.begin.json' },
        { text: 'b', scope: tmKeyScope },
        { text: '"', scope: 'punctuation.support.type.property-name.end.json' },
        { text: ':', scope: 'punctuation.separator.dictionary.key-value.json' },
        { text: '{', scope: tmBracketBegin },
      ],
      // Key at depth 3 (index 2)
      [
        { text: '"', scope: 'punctuation.support.type.property-name.begin.json' },
        { text: 'c', scope: tmKeyScope },
        { text: '"', scope: 'punctuation.support.type.property-name.end.json' },
        { text: ':', scope: 'punctuation.separator.dictionary.key-value.json' },
        { text: '{', scope: tmBracketBegin },
      ],
      // Key at depth 4 (index 3)
      [
        { text: '"', scope: 'punctuation.support.type.property-name.begin.json' },
        { text: 'd', scope: tmKeyScope },
        { text: '"', scope: 'punctuation.support.type.property-name.end.json' },
        { text: ':', scope: 'punctuation.separator.dictionary.key-value.json' },
        { text: '{', scope: tmBracketBegin },
      ],
      // Key at depth 5 (index 4)
      [
        { text: '"', scope: 'punctuation.support.type.property-name.begin.json' },
        { text: 'e', scope: tmKeyScope },
        { text: '"', scope: 'punctuation.support.type.property-name.end.json' },
        { text: ':', scope: 'punctuation.separator.dictionary.key-value.json' },
        { text: '{', scope: tmBracketBegin },
      ],
      // Key at depth 6 (index 5)
      [
        { text: '"', scope: 'punctuation.support.type.property-name.begin.json' },
        { text: 'f', scope: tmKeyScope },
        { text: '"', scope: 'punctuation.support.type.property-name.end.json' },
        { text: ':', scope: 'punctuation.separator.dictionary.key-value.json' },
        { text: '{', scope: tmBracketBegin },
      ],
      // Key at depth 7 (index 6) + open another bracket
      [
        { text: '"', scope: 'punctuation.support.type.property-name.begin.json' },
        { text: 'g', scope: tmKeyScope },
        { text: '"', scope: 'punctuation.support.type.property-name.end.json' },
        { text: ':', scope: 'punctuation.separator.dictionary.key-value.json' },
        { text: '{', scope: tmBracketBegin },
      ],
      // Key at depth 8 (index 7 → wraps to 0)
      [
        { text: '"', scope: 'punctuation.support.type.property-name.begin.json' },
        { text: 'h', scope: tmKeyScope },
        { text: '"', scope: 'punctuation.support.type.property-name.end.json' },
        { text: ':', scope: 'punctuation.separator.dictionary.key-value.json' },
        { text: '"', scope: 'punctuation.definition.string.begin.json' },
        { text: 'val', scope: 'string.quoted.double.json' },
        { text: '"', scope: 'punctuation.definition.string.end.json' },
      ],
      // Closing brackets
      [{ text: '}', scope: tmBracketEnd }],
      [{ text: '}', scope: tmBracketEnd }],
      [{ text: '}', scope: tmBracketEnd }],
      [{ text: '}', scope: tmBracketEnd }],
      [{ text: '}', scope: tmBracketEnd }],
      [{ text: '}', scope: tmBracketEnd }],
      [{ text: '}', scope: tmBracketEnd }],
      [{ text: '}', scope: tmBracketEnd }],
    ]);

    const provider = createJsonTokensProvider(grammar);
    let state = provider.getInitialState();

    const allTokens: Array<Array<{ scope: string }>> = [];
    for (let i = 0; i < 17; i++) {
      const { tokens, endState } = provider.tokenize('', state);
      allTokens.push(tokens.map((t: { scopes: string }) => ({ scope: t.scopes })));
      state = endState;
    }

    // Line 0: bracket passes through unchanged
    expect(allTokens[0]![0]!.scope).toBe(tmBracketBegin);

    // Lines 1-7: keys get depth-tagged scopes (depth0 through depth6)
    expect(allTokens[1]![1]!.scope).toBe(`${tmKeyScope}.depth0`);
    expect(allTokens[2]![1]!.scope).toBe(`${tmKeyScope}.depth1`);
    expect(allTokens[3]![1]!.scope).toBe(`${tmKeyScope}.depth2`);
    expect(allTokens[4]![1]!.scope).toBe(`${tmKeyScope}.depth3`);
    expect(allTokens[5]![1]!.scope).toBe(`${tmKeyScope}.depth4`);
    expect(allTokens[6]![1]!.scope).toBe(`${tmKeyScope}.depth5`);
    expect(allTokens[7]![1]!.scope).toBe(`${tmKeyScope}.depth6`);

    // Line 8: key at depth 8 wraps back to depth0 (7 % 7 = 0)
    expect(allTokens[8]![1]!.scope).toBe(`${tmKeyScope}.depth0`);

    // All 7 depth scopes resolve to distinct colors via the theme
    const rules = generateJsonThemeRules(mockTheme);
    const ruleMap = new Map(rules.map((r) => [r.token, r.foreground]));
    const depthColors = Array.from({ length: 7 }, (_, i) => ruleMap.get(`${tmKeyScope}.depth${i}`));
    expect(new Set(depthColors).size).toBe(7);

    // Closing brackets pass through unchanged
    expect(allTokens[9]![0]!.scope).toBe(tmBracketEnd);
    expect(allTokens[16]![0]!.scope).toBe(tmBracketEnd);

    // Non-key, non-bracket scopes pass through unchanged
    expect(allTokens[8]![4]!.scope).toBe('punctuation.definition.string.begin.json');
    expect(allTokens[8]![5]!.scope).toBe('string.quoted.double.json');
  });
});
