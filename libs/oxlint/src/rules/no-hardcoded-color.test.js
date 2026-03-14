import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { noHardcodedColorRule } from './no-hardcoded-color.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

describe('no-hardcoded-color', () => {
  it('should report hardcoded hex color values', () => {
    ruleTester.run('no-hardcoded-color', noHardcodedColorRule, {
      valid: [
        {
          name: 'semantic Tailwind class',
          code: '<div className="bg-primary text-muted-foreground" />',
        },
        {
          name: 'CSS variable reference',
          code: "const color = 'var(--primary)';",
        },
        {
          name: 'non-color string',
          code: "const id = 'some-text';",
        },
        {
          name: 'fill="none" SVG pattern',
          code: '<path fill="none" />',
        },
        {
          name: 'fill="currentColor" SVG pattern',
          code: '<path fill="currentColor" />',
        },
        {
          name: 'stroke="none" SVG pattern',
          code: '<line stroke="none" />',
        },
        {
          name: 'transparent keyword',
          code: "const bg = 'transparent';",
        },
        {
          name: 'inherit keyword',
          code: "const color = 'inherit';",
        },
        {
          name: 'CSS ID selector (not a color)',
          code: "const selector = '#my-element';",
        },
        {
          name: '5-char hex is not a valid color (CSS ID)',
          code: "const id = '#abcde';",
        },
        {
          name: '7-char hex is not a valid color',
          code: "const id = '#abcdefg';",
        },
        {
          name: 'numeric literal',
          code: 'const x = 42;',
        },
        {
          name: 'boolean literal',
          code: 'const x = true;',
        },
        {
          name: 'hex string with non-hex chars',
          code: "const id = '#xyz123';",
        },
        {
          name: 'hex-like inside longer string',
          code: "const msg = 'Error #ff0000 occurred';",
        },
        {
          name: 'oklch with CSS variable (acceptable pattern)',
          code: "const bg = 'oklch(0.75 0.15 var(--hue-primary) / 0.3)';",
        },
        {
          name: 'hsl wrapping CSS variable reference',
          code: "const c = 'hsl(var(--primary))';",
        },
        {
          name: 'hsla wrapping CSS variable reference',
          code: "const c = 'hsla(var(--accent) / 0.5)';",
        },
        {
          name: 'bare rgba( prefix used for format detection',
          code: "return str.startsWith('rgba(') ? 'RGBA' : 'RGB';",
        },
        {
          name: 'bare hsla( prefix used for format detection',
          code: "return str.startsWith('hsla(') ? 'HSLA' : 'HSL';",
        },
        {
          name: 'bare rgb( prefix',
          code: "const isRgb = value.includes('rgb(');",
        },
        {
          name: 'bare hsl( prefix',
          code: "const isHsl = value.includes('hsl(');",
        },
      ],
      invalid: [
        {
          name: '6-digit hex color',
          code: "const color = '#ff0000';",
          errors: [{ messageId: 'noHardcodedColor' }],
        },
        {
          name: '3-digit hex color',
          code: "const color = '#fff';",
          errors: [{ messageId: 'noHardcodedColor' }],
        },
        {
          name: '8-digit hex with alpha',
          code: "const color = '#ff000080';",
          errors: [{ messageId: 'noHardcodedColor' }],
        },
        {
          name: '4-digit hex with alpha',
          code: "const color = '#fff0';",
          errors: [{ messageId: 'noHardcodedColor' }],
        },
        {
          name: 'uppercase hex',
          code: "const color = '#E5E5E5';",
          errors: [{ messageId: 'noHardcodedColor' }],
        },
        {
          name: 'hex in JSX prop',
          code: '<div style={{ color: "#666666" }} />',
          errors: [{ messageId: 'noHardcodedColor' }],
        },
        {
          name: 'hex in SVG fill attribute',
          code: '<rect fill="#A3A3A3" />',
          errors: [{ messageId: 'noHardcodedColor' }],
        },
        {
          name: 'rgb() function',
          code: "const c = 'rgb(255, 0, 0)';",
          errors: [{ messageId: 'noHardcodedColor' }],
        },
        {
          name: 'rgba() function',
          code: "const c = 'rgba(0, 0, 0, 0.5)';",
          errors: [{ messageId: 'noHardcodedColor' }],
        },
        {
          name: 'hsl() function',
          code: "const c = 'hsl(0, 100%, 50%)';",
          errors: [{ messageId: 'noHardcodedColor' }],
        },
        {
          name: 'hsla() function',
          code: "const c = 'hsla(0, 100%, 50%, 0.5)';",
          errors: [{ messageId: 'noHardcodedColor' }],
        },
        {
          name: 'black hex',
          code: "const c = '#000';",
          errors: [{ messageId: 'noHardcodedColor' }],
        },
        {
          name: 'hex in object property',
          code: "const style = { borderColor: '#ccc' };",
          errors: [{ messageId: 'noHardcodedColor' }],
        },
        {
          name: 'hex in array',
          code: "const colors = ['#14b8a6', '#5B8FD9'];",
          errors: [{ messageId: 'noHardcodedColor' }, { messageId: 'noHardcodedColor' }],
        },
        {
          name: 'hex default parameter',
          code: "function f(color = '#ffaa40') {}",
          errors: [{ messageId: 'noHardcodedColor' }],
        },
        {
          name: 'rgb with no spaces',
          code: "const c = 'rgb(125,56,50)';",
          errors: [{ messageId: 'noHardcodedColor' }],
        },
      ],
    });
  });
});
