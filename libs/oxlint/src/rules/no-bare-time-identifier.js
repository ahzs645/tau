/**
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 * @typedef {import('eslint').Rule.RuleContext} RuleContext
 * @typedef {import('estree').Node} Node
 */

/**
 * Bare time-classifying nouns. When used as the *entire* identifier name they
 * fail to answer "X of/for what?" — the resulting code reads as an operation
 * (`debounce`, `throttle`) or an opaque timing knob (`timeout`, `interval`,
 * `ttl`) without telling the reader what is being timed.
 *
 * Rule: when a declaration we own (type member, variable, parameter, class
 * field) is named *exactly* one of these, require a descriptive prefix —
 * e.g. `refreshDebounce`, `renderTimeout`, `entryTtl`, `coalescingWindow`.
 *
 * Why omit `window` from the banned list: the DOM `window` global causes
 * unavoidable name collisions in main-thread modules. Use `coalescingWindow`
 * / `trackingWindow` etc. by convention, but the rule does not police it
 * mechanically.
 *
 * Why omit `duration` and `elapsed`: these are *measurement* nouns
 * ("elapsed time", "render duration") that are descriptive on their own —
 * they tell you what kind of value, not what operation it is parameterising.
 */
const BANNED_BARE_NAMES = new Set([
  'timeout',
  'debounce',
  'delay',
  'interval',
  'ttl',
  'throttle',
  'period',
  'lifetime',
  'expiry',
  'expires',
]);

/**
 * @param {string} name
 * @returns {boolean}
 */
const isBannedBare = (name) => BANNED_BARE_NAMES.has(name);

/** @type {RuleModule} */
export const noBareTimeIdentifierRule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow bare time-classifying identifiers (`timeout`, `debounce`, `delay`, `interval`, ' +
        '`ttl`, `throttle`, `period`, `lifetime`, `expiry`, `expires`) at declaration sites we own. ' +
        'Require a descriptive prefix (e.g. `renderTimeout`, `refreshDebounce`, `entryTtl`) so the ' +
        'reader knows *what* is being timed, not just the operation. Object-literal property keys are ' +
        'exempt to avoid false positives on external APIs (`requestIdleCallback({ timeout })`, ' +
        '`vi.test(_, { timeout })`, xstate `waitFor(_, _, { timeout })`). See ' +
        '`docs/policy/jsdoc-policy.md` "Time Units in JSDoc" for naming guidance.',
    },
    messages: {
      bareTime:
        "Identifier '{{name}}' is a bare time-classifying noun. " +
        'Add a descriptive prefix that says *what* is being timed — for example ' +
        '`render{{capitalised}}`, `refresh{{capitalised}}`, `entry{{capitalised}}`. ' +
        'See docs/policy/jsdoc-policy.md "Time Units in JSDoc".',
    },
    schema: [],
  },
  create(context) {
    /** @param {Node & { name?: string }} node */
    const checkIdentifier = (node) => {
      const { name } = node;
      if (typeof name !== 'string') {
        return;
      }
      if (!isBannedBare(name)) {
        return;
      }
      const capitalised = name[0].toUpperCase() + name.slice(1);
      context.report({ node, messageId: 'bareTime', data: { name, capitalised } });
    };

    /**
     * Variable declarators where the initializer is a function expression — these are
     * function definitions (`const debounce = (...) => {...}`, `const sleep = async (ms) => ...`)
     * whose name describes the *operation*, not a duration variable. Exempt them.
     * @param {Node & { id?: Node; init?: Node | null }} node
     */
    const checkVariableDeclarator = (node) => {
      const { init } = node;
      if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
        return;
      }
      const { id } = node;
      if (id && id.type === 'Identifier') {
        checkIdentifier(/** @type {Node & { name?: string }} */ (id));
      }
    };

    return {
      // `const debounce = 500;` / `let interval = 0;` — but skip function expressions.
      VariableDeclarator: checkVariableDeclarator,
      // `function f(timeout) {}` / `(delay) => {}` — params declared as bare Identifier.
      'FunctionDeclaration > Identifier.params': checkIdentifier,
      'FunctionExpression > Identifier.params': checkIdentifier,
      'ArrowFunctionExpression > Identifier.params': checkIdentifier,
      // Class fields: `private readonly debounce: number;`
      'PropertyDefinition[computed=false] > Identifier.key': checkIdentifier,
      // TypeScript type/interface members: `{ timeout?: number }` in a TSTypeLiteral.
      'TSPropertySignature[computed=false] > Identifier.key': checkIdentifier,
      // Constructor parameter properties: `constructor(public readonly timeout: number)`.
      'TSParameterProperty > Identifier.parameter': checkIdentifier,
      // NOTE: deliberately NOT firing on `Property` keys — those appear at object-literal
      // call sites where we may be matching an external API's shape (DOM, vitest, xstate).
    };
  },
};
