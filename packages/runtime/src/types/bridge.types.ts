/**
 * Generic constraint that accepts any non-primitive value with string-keyed
 * properties — both plain objects (`Record<string, unknown>`) and class
 * instances (which lack explicit index signatures).
 *
 * Use as a generic constraint when a function needs to dynamically access
 * string-keyed properties on either plain objects or class instances:
 *
 * ```typescript
 * import type { StringKeyedObject } from '@taucad/runtime';
 *
 * function dispatch<T extends StringKeyedObject>(handlers: T): void {
 *   const method = (handlers as Record<string, unknown>)['methodName'];
 * }
 * ```
 *
 * **Why not `Record<string, unknown>`?**
 * Class instances don't have an explicit index signature. TypeScript reports
 * "Index signature for type 'string' is missing in type 'ClassName'" when a
 * class instance is passed to a `T extends Record<string, unknown>` parameter.
 *
 * @public
 *
 * @see https://github.com/microsoft/TypeScript/issues/15300 — Index signature missing for class instances
 * @see https://github.com/sindresorhus/type-fest/blob/main/source/simplify.d.ts — type-fest's call-site workaround
 */
// oxlint-disable-next-line @typescript-eslint/no-restricted-types -- intentional named alias; `object` is the correct constraint for accepting class instances alongside plain objects
export type StringKeyedObject = object;
