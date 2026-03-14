/**
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 */

/**
 * Matches hex color strings: #rgb, #rgba, #rrggbb, #rrggbbaa.
 * Anchored to avoid matching CSS IDs like `'#some-id'`.
 */
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Matches functional CSS color notations with actual values: rgb(...), rgba(...), hsl(...), hsla(...).
 * Requires at least one digit after the opening paren to avoid matching bare prefixes like `'rgba('`.
 */
const FUNCTIONAL_COLOR_PATTERN = /^(?:rgba?|hsla?)\s*\(\s*\d/i;

/**
 * Detects CSS variable references inside functional notations (e.g. `hsl(var(--primary))`).
 * These are token-based and should not be flagged.
 */
const CSS_VAR_PATTERN = /var\s*\(--/;

/** @type {RuleModule} */
export const noHardcodedColorRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hardcoded color values (hex, rgb, hsl) in component files. ' +
        'Use semantic design tokens from `global.css` instead. ' +
        'See `docs/policy/color-policy.md` for the full color system rules.',
    },
    messages: {
      noHardcodedColor:
        'Hardcoded color `{{ value }}` violates color policy. ' +
        'Use a semantic token (e.g. `bg-primary`, `text-muted-foreground`, `border-border`) ' +
        'or define a new token in `global.css`. ' +
        'For Three.js/WebGL colors, move to a `*.constants.ts` file and disable this rule inline.',
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== 'string') {
          return;
        }

        const value = node.value;

        if (CSS_VAR_PATTERN.test(value)) {
          return;
        }

        if (HEX_COLOR_PATTERN.test(value) || FUNCTIONAL_COLOR_PATTERN.test(value)) {
          context.report({ node, messageId: 'noHardcodedColor', data: { value } });
        }
      },
    };
  },
};
