/**
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 */

/** @type {RuleModule} */
export const noLiteralConstAssertionRule = {
  meta: {
    type: 'problem',
    fixable: 'code',
    docs: {
      description:
        'Disallow `as const` assertions on individual literal values (e.g. `"foo" as const`, `true as const`). ' +
        'When the return type is constrained by generics, explicit annotations, or contextual typing, ' +
        '`as const` on a literal is a no-op. Use explicit return types or generic parameters to preserve literal types.',
    },
    messages: {
      unnecessary:
        'Unnecessary `as const` on a literal value. ' +
        'Remove it — contextual typing, generics, or explicit return types already preserve the literal type. ' +
        'If `as const` IS needed (e.g. inside a .map() callback where contextual typing is lost), ' +
        'move it to the outermost container: `{ ...obj } as const` or `[...arr] as const` instead of individual properties.',
    },
  },
  create(context) {
    return {
      TSAsExpression(node) {
        if (node.expression?.type !== 'Literal') {
          return;
        }

        // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- ESTree AST node property access in plugin visitor
        const ta = node.typeAnnotation;
        if (ta?.type !== 'TSTypeReference' || ta.typeName?.name !== 'const') {
          return;
        }

        context.report({
          node, // oxlint-disable-line @typescript-eslint/no-unsafe-assignment -- ESTree AST node passed to context.report
          messageId: 'unnecessary',
          fix(fixer) {
            return fixer.replaceTextRange([node.expression.range[1], node.range[1]], '');
          },
        });
      },
    };
  },
};
