/**
 * Type-aware ESLint rule: every expression whose inferred type carries a
 * `[Symbol.dispose](): void` (or `[Symbol.asyncDispose](): PromiseLike<void>`)
 * member must be bound to a `using` / `await using` declaration (or be
 * explicitly forwarded via `return` / `throw` / a `DisposableStack.use(...)`
 * sink) so the resource is released at scope exit.
 *
 * Without `using` the dispose method is never invoked and the resource
 * leaks (e.g. Embind-managed WASM handles in OCJS — every `gp_Pnt`,
 * `TopoDS_Shape`, RBV container).
 *
 * Auto-fix (single case):
 *   - `const x = expr;`  →  `using x = expr;`
 *
 * Reported without auto-fix (human must introduce a `using` binding with a
 * sensible name and rewire the expression):
 *   - `let x = expr;` — `using` is const-equivalent; reassignment would break.
 *   - destructuring (`const { a } = expr`) — capture container in `using`, then destructure.
 *   - inline temporaries (`foo(new X())`) — hoist `using name = <expr>;` above the statement.
 *
 * Standard-library disposables (`IterableIterator`, `AsyncIterator`,
 * `Array.values()`, etc. that became Disposable in TS 5.2+) are exempt:
 * their dispose implementations are no-ops and flagging them generates
 * noise. The exemption keys off the declaration file path
 * (`/lib/lib.*.d.ts`).
 *
 * **Return-flow escape (intra-procedural):** `const x = <disposable>(); … return …`
 * where the expression tree of `return`’s argument contains a read of `x`
 * is treated as ownership forwarded to the caller (mirrors
 * `@typescript-eslint/no-floating-promises` accepting `const p = f(); return p;`).
 * The rule does not analyze closure captures (`{ cleanup: () => x.delete() }`),
 * aliases through outer `let`, or cross-function callers — use `using`, refactor,
 * or a targeted `eslint-disable` with rationale.
 *
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 * @typedef {import('eslint').Rule.RuleContext} RuleContext
 * @typedef {import('eslint').Rule.RuleFixer} RuleFixer
 * @typedef {import('eslint').Rule.Node} EslintRuleNode
 * @typedef {import('estree').Node} EstreeNode
 * @typedef {import('estree').CallExpression} CallExpression
 * @typedef {import('estree').NewExpression} NewExpression
 * @typedef {import('estree').VariableDeclaration} VariableDeclaration
 * @typedef {import('estree').VariableDeclarator} VariableDeclarator
 */

const DISPOSABLE_STACK_SINKS = new Set(['use', 'adopt', 'defer']);

/**
 * Returns true iff the property's declaration originates from a TypeScript
 * standard `lib.*.d.ts` file. Built-in `[Symbol.dispose]` implementations
 * (e.g. `IterableIterator` since TS 5.2) are exempt — flagging them
 * generates noise without catching real leaks.
 *
 * @param {import('typescript').Symbol} prop
 * @returns {boolean}
 */
function propertyIsFromStandardLib(prop) {
  const decls = prop.getDeclarations?.() ?? prop.declarations;
  if (!decls || decls.length === 0) return false;
  return decls.every((decl) => {
    const fileName = decl.getSourceFile()?.fileName ?? '';
    if (!fileName) return false;
    return /[\\/]lib\.[^\\/]+\.d\.ts$/.test(fileName);
  });
}

/**
 * @param {import('typescript').TypeChecker} checker
 * @param {import('typescript').Type} type
 * @returns {boolean}
 */
function typeHasSymbolDispose(checker, type) {
  if (!type) return false;
  if (type.isUnionOrIntersection?.()) {
    for (const member of type.types) {
      if (typeHasSymbolDispose(checker, member)) return true;
    }
    return false;
  }
  const props = checker.getPropertiesOfType(type);
  for (const prop of props) {
    const name = String(prop.escapedName);
    const isDispose =
      name.startsWith('__@dispose@') ||
      name === '[Symbol.dispose]' ||
      name.startsWith('__@asyncDispose@') ||
      name === '[Symbol.asyncDispose]';
    if (!isDispose) continue;
    if (propertyIsFromStandardLib(prop)) continue;
    return true;
  }
  return false;
}

/**
 * Walk past "transparent" wrapper expressions that don't capture
 * ownership. Returns the outermost expression node still owning the
 * disposable value.
 *
 * @param {EstreeNode} node
 * @returns {EstreeNode}
 */
function unwrapOwnership(node) {
  let current = /** @type {EstreeNode & { parent?: EstreeNode }} */ (node);
  while (current.parent) {
    const parent =
      /** @type {EstreeNode & { parent?: EstreeNode; type: string; expression?: EstreeNode; argument?: EstreeNode }} */ (
        current.parent
      );
    if (parent.type === 'AwaitExpression' && parent.argument === current) {
      current = parent;
      continue;
    }
    if (
      (parent.type === 'TSAsExpression' ||
        parent.type === 'TSTypeAssertion' ||
        parent.type === 'TSSatisfiesExpression' ||
        parent.type === 'TSNonNullExpression') &&
      parent.expression === current
    ) {
      current = parent;
      continue;
    }
    if (parent.type === 'ChainExpression') {
      current = parent;
      continue;
    }
    break;
  }
  return current;
}

/**
 * @param {EstreeNode | null | undefined} root
 * @param {EstreeNode} target
 * @returns {boolean}
 */
function containsExpressionNode(root, target) {
  if (root === target) return true;
  if (!root || typeof root !== 'object') return false;
  for (const key of Object.keys(root)) {
    if (key === 'parent' || key === 'range' || key === 'loc' || key === 'start' || key === 'end') {
      continue;
    }
    const val = /** @type {any} */ (root)[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object' && containsExpressionNode(item, target)) {
          return true;
        }
      }
    } else if (val && typeof val === 'object' && 'type' in val) {
      if (containsExpressionNode(val, target)) return true;
    }
  }
  return false;
}

/**
 * True when this identifier is read inside some `return` statement’s argument
 * (e.g. `return x`, `return { x }`, `return foo(x)`).
 *
 * @param {import('estree').Identifier} identifier
 * @returns {boolean}
 */
function referenceEscapesViaReturn(identifier) {
  let node = /** @type {EstreeNode & { parent?: EstreeNode }} */ (identifier);
  while (node.parent) {
    const parent = node.parent;
    if (parent.type === 'ReturnStatement' && parent.argument && containsExpressionNode(parent.argument, identifier)) {
      return true;
    }
    node = parent;
  }
  return false;
}

/**
 * Determine whether `node`'s syntactic context absorbs the dispose
 * obligation. If yes, no diagnostic is produced.
 *
 * @param {EstreeNode} node
 * @param {RuleContext | undefined} context
 * @returns {boolean}
 */
function isOwnedByContext(node, context) {
  const outer = unwrapOwnership(node);
  const parent =
    /** @type {EstreeNode & { parent?: EstreeNode; type: string; init?: EstreeNode; argument?: EstreeNode; expression?: EstreeNode; body?: EstreeNode | unknown; kind?: string; arguments?: EstreeNode[]; callee?: EstreeNode; property?: EstreeNode; name?: string; id?: EstreeNode }} */ (
      /** @type {any} */ (outer).parent
    );
  if (!parent) return false;

  // `using x = expr;` / `await using x = expr;`
  if (parent.type === 'VariableDeclarator' && parent.init === outer) {
    const declList = /** @type {any} */ (parent).parent;
    if (declList && declList.type === 'VariableDeclaration') {
      const kind = declList.kind;
      if (kind === 'using' || kind === 'await using') return true;
      // `const x = <disposable>();` forwarded when any read escapes via `return`.
      if (kind === 'const' && context && parent.id?.type === 'Identifier') {
        const scope = context.sourceCode.getScope(/** @type {any} */ (parent));
        const variable = scope.variables.find((v) => v.name === parent.id.name);
        if (variable && variable.references.some((ref) => referenceEscapesViaReturn(ref.identifier))) {
          return true;
        }
      }
    }
  }

  // `return expr;` / `throw expr;` / `yield expr` / arrow expression body
  if (parent.type === 'ReturnStatement' && parent.argument === outer) return true;
  if (parent.type === 'ThrowStatement' && parent.argument === outer) return true;
  if (parent.type === 'YieldExpression' && parent.argument === outer) return true;
  if (parent.type === 'ArrowFunctionExpression' && parent.body === outer) return true;

  // `stack.use(expr)` / `stack.adopt(expr, _)` / `stack.defer(...)`
  if (parent.type === 'CallExpression' && parent.callee && parent.callee.type === 'MemberExpression') {
    const property = /** @type {any} */ (parent.callee).property;
    if (
      property?.type === 'Identifier' &&
      DISPOSABLE_STACK_SINKS.has(property.name) &&
      parent.arguments?.[0] === outer
    ) {
      return true;
    }
  }

  return false;
}

/**
 * @param {VariableDeclaration & { kind: 'const' | 'let' | 'var' | 'using' | 'await using' }} declNode
 * @returns {{ start: number; length: number } | null}
 *   Source-text range of the declaration keyword (`const` / `let`) or null
 *   if it can't be located.
 */
function findKeywordRange(declNode) {
  const range = /** @type {readonly [number, number] | undefined} */ (/** @type {any} */ (declNode).range);
  if (!range) return null;
  const kind = declNode.kind;
  // `range[0]` points at the start of the declaration text. The keyword is
  // the first whitespace-trimmed identifier.
  return { start: range[0], length: kind.length };
}

/** @type {RuleModule} */
export const requireUsingOnDisposableRule = {
  meta: {
    type: 'problem',
    fixable: 'code',
    docs: {
      description:
        'Require `using` / `await using` declarations for expressions whose inferred ' +
        'type has `[Symbol.dispose]: () => void`. Prevents resource leaks where the ' +
        'caller forgot to invoke `.delete()` / `[Symbol.dispose]()` at scope exit. ' +
        'Auto-fixes only `const x = …` → `using x = …`. Destructuring and ' +
        'inline disposable expressions must be fixed manually.',
    },
    messages: {
      missingUsing:
        'Disposable expression (type `{{typeText}}`) is not bound to `using` / `await using`. ' +
        'Replace `const x = ...` / `let x = ...` with `using x = ...` so ' +
        '`[Symbol.dispose]()` runs at scope exit, or forward via `return` / `stack.use(...)`.',
      missingUsingInline:
        'Disposable expression (type `{{typeText}}`) is created inline without `using`. ' +
        'Add a preceding line `using <name> = <expr>;` with a descriptive name, then pass `<name>` where the expression was.',
      missingUsingDestructure:
        'Disposable expression (type `{{typeText}}`) is destructured directly. ' +
        '`using` cannot bind to destructuring patterns — capture the container in a ' +
        '`using` variable first, then read its fields.',
    },
    schema: [],
  },
  create(context) {
    // `parserServices` is set up by typescript-eslint when
    // `parserOptions.project` is configured. Fall back to a no-op if the
    // consumer hasn't enabled type-aware linting.
    const services = /** @type {any} */ (context).sourceCode?.parserServices ??
    /** @type {any} */ (context).parserServices;
    const program = services?.program;
    const esTreeNodeToTSNodeMap = services?.esTreeNodeToTSNodeMap;
    if (!program || !esTreeNodeToTSNodeMap) {
      return {};
    }
    const checker = program.getTypeChecker();

    /**
     * @param {NewExpression | CallExpression} esNode
     */
    const checkExpression = (esNode) => {
      const tsNode = esTreeNodeToTSNodeMap.get(esNode);
      if (!tsNode) return;
      const type = checker.getTypeAtLocation(tsNode);
      if (!typeHasSymbolDispose(checker, type)) return;
      if (isOwnedByContext(/** @type {EstreeNode} */ (esNode), context)) return;

      const outer = unwrapOwnership(/** @type {EstreeNode} */ (esNode));
      const parent = /** @type {any} */ (outer).parent;
      const typeText = checker.typeToString(type);

      // Case A: `const x = expr;` → auto-fix by replacing the keyword
      // with `using`. `let x = expr;` is reported but NOT auto-fixed —
      // `using` is `const`-equivalent so any downstream `x = …` would
      // become a compile error.
      if (
        parent?.type === 'VariableDeclarator' &&
        parent.init === outer &&
        parent.id?.type === 'Identifier' &&
        parent.parent?.type === 'VariableDeclaration'
      ) {
        const declNode = /** @type {VariableDeclaration & { kind: string }} */ (parent.parent);
        if (declNode.kind === 'const') {
          const keywordRange = findKeywordRange(/** @type {any} */ (declNode));
          context.report({
            node: /** @type {any} */ (esNode),
            messageId: 'missingUsing',
            data: { typeText },
            fix: keywordRange
              ? (fixer) =>
                  fixer.replaceTextRange([keywordRange.start, keywordRange.start + keywordRange.length], 'using')
              : undefined,
          });
          return;
        }
        if (declNode.kind === 'let') {
          context.report({
            node: /** @type {any} */ (esNode),
            messageId: 'missingUsing',
            data: { typeText },
          });
          return;
        }
      }

      // Case B: destructured (`const { A } = expr` / `const [a] = expr`) — no
      // auto-fix: choose a meaningful `using` name and split into two lines.
      if (
        parent?.type === 'VariableDeclarator' &&
        parent.init === outer &&
        (parent.id?.type === 'ObjectPattern' || parent.id?.type === 'ArrayPattern')
      ) {
        context.report({
          node: /** @type {any} */ (esNode),
          messageId: 'missingUsingDestructure',
          data: { typeText },
        });
        return;
      }

      // Case C: inline disposable — no auto-fix: hoist `using <name> = …` manually.
      context.report({
        node: /** @type {any} */ (esNode),
        messageId: 'missingUsingInline',
        data: { typeText },
      });
    };

    return {
      NewExpression: checkExpression,
      CallExpression: checkExpression,
    };
  },
};

/**
 * Default export — registry-friendly shape for plugin authors who want
 * to reference the rule by camelCase or by file basename.
 */
export default requireUsingOnDisposableRule;
