/**
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 * @typedef {import('eslint').Rule.RuleContext} RuleContext
 * @typedef {import('estree').Node} Node
 * @typedef {import('estree').CallExpression} CallExpression
 * @typedef {import('estree').UnaryExpression} UnaryExpression
 * @typedef {import('estree').Comment} Comment
 */

/**
 * Escape-hatch annotation. When the line immediately preceding a `void`-fired
 * async IIFE (or any expression statement matching the rule) carries this
 * comment, the rule reports nothing. Example:
 *
 *     // async-iife: bootstrap — top-level worker init must defer Web Worker
 *     // resolution to runtime; see kernel-runtime-worker.ts.
 *     void (async () => { ... })();
 */
const ESCAPE_HATCH_TAG = 'async-iife: bootstrap';

/**
 * @param {Node} node
 * @returns {node is UnaryExpression}
 */
const isVoidUnary = (node) => node.type === 'UnaryExpression' && node.operator === 'void';

/**
 * @param {Node} node
 * @returns {boolean}
 */
const isAsyncIIFE = (node) => {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee.type !== 'ArrowFunctionExpression' && callee.type !== 'FunctionExpression') {
    return false;
  }
  return callee.async === true;
};

/**
 * `void promise.then(...)` — fire-and-forget on a returned Promise. Captures
 * `void someAsync().then(handler)` and `void this.thing.then(...)` patterns.
 * @param {Node} node
 * @returns {boolean}
 */
const isVoidThenChain = (node) => {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee.type !== 'MemberExpression') return false;
  const property = callee.property;
  if (property.type !== 'Identifier') return false;
  return property.name === 'then' || property.name === 'catch' || property.name === 'finally';
};

/**
 * @param {RuleContext} context
 * @param {Node} node
 * @returns {boolean}
 */
const hasEscapeHatchComment = (context, node) => {
  const sourceCode = context.sourceCode ?? context.getSourceCode();
  /** @type {Comment[]} */
  const comments = sourceCode.getCommentsBefore(node);
  if (comments.length === 0) return false;
  return comments.some((comment) => comment.value.includes(ESCAPE_HATCH_TAG));
};

/** @type {RuleModule} */
export const noAsyncIifeRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow `void (async () => { ... })()` and `void promise.then(...)` fire-and-forget patterns. ' +
        'These hide async work behind a synchronous façade — callers cannot await completion, ' +
        'errors land on the unhandled-rejection path instead of typed catch blocks, and tests cannot ' +
        'observe settlement deterministically. Refactor to either (a) make the enclosing function ' +
        '`async` and `await` the promise, or (b) explicitly track the promise via a registry ' +
        "(e.g. the runtime client's `inFlightIntents` set). For top-level worker bootstraps where " +
        '`async` cannot be declared on the outer scope, annotate with `// async-iife: bootstrap` to ' +
        'suppress this rule. See `docs/policy/library-api-policy.md` §22.',
    },
    messages: {
      voidAsyncIife:
        'Void-fired async IIFE hides asynchronous work behind a synchronous façade. ' +
        'Make the enclosing function async and await the promise, or track it explicitly via a ' +
        'registry. For unavoidable top-level worker bootstraps, annotate with `// async-iife: bootstrap`.',
      voidThenChain:
        'Void-fired Promise chain (`void p.then(...)` / `.catch` / `.finally`) hides the settlement ' +
        'from callers and tests. Either await the chain in an async function, return it, or store ' +
        'it in an explicit tracking set. For unavoidable cases annotate with `// async-iife: bootstrap`.',
    },
    schema: [],
  },
  create(context) {
    /**
     * @param {Node} node
     */
    const reportIfVoidAsyncIife = (node) => {
      if (!isVoidUnary(node)) return;
      const argument = /** @type {UnaryExpression} */ (node).argument;
      if (isAsyncIIFE(argument)) {
        if (hasEscapeHatchComment(context, node)) return;
        context.report({ node, messageId: 'voidAsyncIife' });
        return;
      }
      if (isVoidThenChain(argument)) {
        if (hasEscapeHatchComment(context, node)) return;
        context.report({ node, messageId: 'voidThenChain' });
      }
    };

    return {
      UnaryExpression: reportIfVoidAsyncIife,
    };
  },
};
