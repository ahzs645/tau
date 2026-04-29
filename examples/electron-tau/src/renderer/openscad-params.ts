/**
 * Tiny OpenSCAD top-level parameter extractor used by the PoC renderer.
 *
 * Scans the source for `name = literal;` declarations and produces a list
 * of `{ name, defaultValue }` records. The OpenSCAD kernel does the same
 * thing internally — re-implementing it locally keeps the renderer free
 * of the kernel-runtime worker for the parameters-form unit tests, while
 * the real kernel still drives renders over IPC.
 *
 * Supports number and string literals, which is enough to drive the
 * `len → length` rename validation (p1-electron-validate-rename).
 */

export type ScadParam = {
  readonly name: string;
  readonly defaultValue: number | string;
};

/* JS `RegExp` is good enough for the demo: top-level `<ident> = <literal>;`. */
const PARAM_DECL = /^[\t ]*([A-Z_a-z][\w$]*)[\t ]*=[\t ]*(-?\d+(?:\.\d+)?|"[^"]*")[\t ]*;/gm;

export function extractParams(source: string): ScadParam[] {
  const params: ScadParam[] = [];
  const seen = new Set<string>();
  PARAM_DECL.lastIndex = 0;
  let match: RegExpExecArray | undefined;
  while ((match = PARAM_DECL.exec(source) ?? undefined)) {
    const name = match[1]!;
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const literal = match[2]!;
    const defaultValue = literal.startsWith('"') ? literal.slice(1, -1) : Number(literal);
    params.push({ name, defaultValue });
  }
  return params;
}
