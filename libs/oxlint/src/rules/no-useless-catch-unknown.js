/**
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 */

/** @type {RuleModule} */
export const noUselessCatchUnknownRule = {
  meta: {
    type: 'suggestion',
    fixable: 'code',
    docs: {
      description:
        'Disallow `catch (error: unknown)` type annotations. ' +
        'With `useUnknownInCatchVariables` enabled (or strict mode), ' +
        'catch clause variables are already typed as `unknown`, making the annotation redundant.',
    },
    messages: {
      unnecessary:
        'Unnecessary `: unknown` type annotation on catch clause variable. ' +
        'With strict TypeScript config, catch variables are already `unknown`.',
    },
  },
  create(context) {
    return {
      CatchClause(node) {
        const param = node.param;
        if (!param?.typeAnnotation) {
          return;
        }

        const annotation = param.typeAnnotation.typeAnnotation;
        if (annotation?.type !== 'TSUnknownKeyword') {
          return;
        }

        context.report({
          node: param.typeAnnotation,
          messageId: 'unnecessary',
          fix(fixer) {
            return fixer.removeRange(param.typeAnnotation.range);
          },
        });
      },
    };
  },
};
