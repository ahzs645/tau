---
title: 'Diff Viewer Shiki Notation Leak in Non-`//` Languages'
description: 'Root cause investigation for `// [!code ++]` markers leaking through `DiffViewer` (chat-tool-file-operation) when the target file uses a language without `//` line comments (USDA, bash, JSON, STEP, STL).'
status: active
created: '2026-05-02'
updated: '2026-05-02'
category: investigation
related:
  - docs/policy/react-testing-policy.md
---

# Diff Viewer Shiki Notation Leak in Non-`//` Languages

Investigation into why `// [!code ++]` and `// [!code --]` markers render as visible code in the chat edit-file tool's `DiffViewer` for some files (e.g. `scene.usda`) but render correctly (as styled diff lines) for `.scad`/`.ts`/`.js` files.

## Implementation status

**Resolved in tree.** `DiffViewer` applies `diff add` / `diff remove` via Shiki's per-line transformer hook (`buildDiffLineTransformer` in `apps/ui/app/components/code/diff-viewer.tsx`). `@shikijs/transformers` / `transformerNotationDiff` were removed from the UI highlighter path. Regression coverage: `apps/ui/app/components/code/diff-viewer.test.tsx`.

## Executive Summary

`DiffViewer` (`apps/ui/app/components/code/diff-viewer.tsx`) hard-codes JavaScript-style `// [!code ++]` / `// [!code --]` notation onto every diff line regardless of the file's language. Shiki's `transformerNotationDiff` only strips a notation marker after Shiki's grammar tokenizer has classified the surrounding text as a comment token — the upstream comment matcher does _not_ run on raw text. For languages whose grammar lacks a `//` line-comment rule (USDA, bash, JSON, STEP, STL), the marker is tokenized as ordinary punctuation/text, the transformer never matches it, and the literal `// [!code ++]` text leaks into the rendered HTML alongside the wrong styling.

This is a **consumer (Tau) bug**, not an upstream Shiki bug. Upstream behaviour is correct by design: `[!code ...]` notations are explicitly defined to live inside language-native comments. The fix belongs in `linesToShikiNotation` / `DiffViewer`.

The clean architectural fix is to drop comment-notation entirely and use Shiki's first-class `decorations` API: we already compute the diff client-side via the `diff` package, so we know exact line ranges and can apply `diff add` / `diff remove` classes directly via `decorations` without going through comment tokens at all.

## Problem Statement

Reproduction: edit a USDA file (`scene.usda`) via the chat agent. The `chat-message-tool-edit-file` card opens with `CollapsibleFileOperation` → `DiffPreview` → `DiffViewer`, and every "added" line in the diff shows the raw notation marker as part of the rendered code:

```text
#usda 1.0 // [!code ++]
( // [!code ++]
    defaultPrim = "World" // [!code ++]
    metersPerUnit = 1 // [!code ++]
    upAxis = "Y" // [!code ++]
    ...
```

The expected output is the same lines without the trailing `// [!code ++]` and with the green "added line" background plus left border that Shiki's diff transformer normally produces (visible today on `.scad` / `.ts` files).

The same bug repros with any language whose grammar does not define `//` as a line comment. In our registry that includes:

| Language      | Comment syntax                                       | `//` is a comment? |
| ------------- | ---------------------------------------------------- | ------------------ |
| `usd`         | `#`, `/* … */`                                       | No                 |
| `bash`        | `#`                                                  | No                 |
| `json`        | (none — JSON5 has `//` but we register stock `json`) | No                 |
| `stepfile`    | `/* … */`                                            | No                 |
| `stl`         | (none)                                               | No                 |
| `javascript`  | `//`, `/* … */`                                      | Yes                |
| `typescript`  | `//`, `/* … */`                                      | Yes                |
| `jsx` / `tsx` | `//`, `/* … */`, `{/* … */}`                         | Yes                |
| `openscad`    | `//`, `/* … */`                                      | Yes                |
| `kcl`         | `//`, `/* … */`                                      | Yes                |

Diff rendering works for the bottom five and is broken for the top five.

## Methodology

1. Read the consumer call site: `chat-tool-file-operation.tsx` → `DiffPreview` → `DiffViewer`.
2. Read `DiffViewer` and traced exactly how it injects notation: `linesToShikiNotation` always appends `// [!code ${type}]`.
3. Read the upstream `@shikijs/transformers@3.22.0` source (`dist/index.mjs`) to understand how `transformerNotationDiff` matches markers.
4. Cross-checked the USDA grammar (`apps/ui/app/lib/usd-language/usd.tmLanguage.json`) to confirm it has no `//` rule.
5. Confirmed Shiki ships a first-class `decorations` API (`@shikijs/core` + `@shikijs/types` `DecorationOptions` / `DecorationItem`) that makes the comment-notation detour optional.

## Findings

### Finding 1: `linesToShikiNotation` hard-codes `//` regardless of language

`apps/ui/app/components/code/diff-viewer.tsx` (lines 169–183):

```169:183:apps/ui/app/components/code/diff-viewer.tsx
function linesToShikiNotation(lines: DiffLine[]): string {
  return lines
    .map((line) => {
      if (line.type === 'added') {
        return `${line.content} // [!code ++]`;
      }

      if (line.type === 'removed') {
        return `${line.content} // [!code --]`;
      }

      return line.content;
    })
    .join('\n');
}
```

The marker prefix is always `//` even though the surrounding `DiffViewer` already receives the resolved `language` prop. This is the root injection point.

### Finding 2: Shiki's notation transformer requires a _real_ comment token, not a raw `//` substring

The upstream matcher in `@shikijs/transformers@3.22.0/dist/index.mjs` works on the post-tokenization HAST tree, not on raw text. Relevant excerpt:

```javascript
// /node_modules/.pnpm/@shikijs+transformers@3.22.0/.../dist/index.mjs
const matchers = [
  [/^(<!--)(.+)(-->)$/, false],
  [/^(\/\*)(.+)(\*\/)$/, false],
  [/^(\/\/|["'#]|;{1,2}|%{1,2}|--)(.*)$/, true],
  [/^(\*)(.+)$/, true],
];

function parseComments(lines, jsx, matchAlgorithm) {
  // …
  for (const line of lines) {
    // walks `line.children` (HAST elements emitted by Shiki's grammar tokenizer)
    // and looks for the *last* element whose text starts with one of the
    // comment markers above.
  }
}
```

In `parseComments`, each `line.children[i]` is a Shiki `<span class="…">` element produced by the grammar. `matchToken` is called on the inner text of those elements. The matcher only succeeds when:

1. The token's `trimStart()` text begins with `//`, `#`, `;`, `--`, `*`, `"…"`, `/* … */`, or `<!-- … -->`.
2. For the line-comment matchers (third row, `endOfLine: true`), the matched element must be the **last** element of the line.

The v3 algorithm has a soft-split helper that splits the _last_ token by `\s+\/\/`, but it only runs **after** `matchToken` already returned a hit on that token:

```javascript
const isComment = matchToken(token.value, isLast);
if (!isComment) return element;
const rawSplits = token.value.split(/(\s+\/\/)/);
```

If the first call to `matchToken` returns `undefined` because the token doesn't begin with a recognized comment marker, the split is skipped entirely. There is no fallback path that scans for `[!code …]` independent of comment context.

### Finding 3: USDA grammar does not classify `//` as a comment, so Shiki tokenizes the marker as text

`apps/ui/app/lib/usd-language/usd.tmLanguage.json` declares only two comment patterns:

```125:166:apps/ui/app/lib/usd-language/usd.tmLanguage.json
"comment": {
  "patterns": [
    {
      "name": "comment.block.usd",
      "begin": "(/\\*)(?:\\s*((@)internal)(?=\\s|(\\*/)))?",
      …
      "end": "\\*/",
      …
    },
    {
      "begin": "(^[ \\t]+)?((#)(?:\\s*((@)internal)(?=\\s|$))?)",
      …
      "contentName": "comment.line.hash.usd"
    }
  ]
}
```

Block comments only via `/* … */`, line comments only via `#`. There is no `//` rule. When Shiki tokenizes a line like `defaultPrim = "World" // [!code ++]`, the trailing `// [!code ++]` is not matched by `#comment` and instead falls through to whichever of `#variables`, `#number`, or default text patterns absorbs each fragment. The resulting HAST line's last child is _not_ a comment-style token, so `matchToken` returns `undefined` for all three line-comment matcher rows, and the v3 split fast-path is skipped.

The marker therefore survives parsing untouched, and its raw text is rendered into the page as a span (often styled as `variable.parameter.usda` because `[a-zA-Z_:][a-zA-Z0-9_:]*` matches `code` greedily inside the brackets).

### Finding 4: The same failure mode applies to every non-`//` language we register

`apps/ui/app/lib/shiki.lib.ts` (lines 18–34) registers ten languages. Five of them lack `//` line comments (see Problem Statement table). For all five, `DiffViewer` will leak `// [!code ++]` / `// [!code --]` markers whenever the user edits one of those files via the chat agent. This is a latent bug across the whole non-`//` set; the user happened to hit USDA first because that's what the chat agent generated.

### Finding 5: This is a consumer bug, not upstream

Shiki's design is explicit and consistent: `transformerNotationDiff` is a _language-comment-aware_ transformer. The README and v3 release notes describe `[!code ++]` as a marker that lives inside a comment in the host language. The matcher set above includes `//`, `#`, `--`, `;`, `;;`, `%`, `%%`, `/* … */`, `<!-- … -->`, and lone `*` (multi-line C comment continuation) — i.e. it deliberately covers the comment syntaxes of the languages Shiki ships. The bug appears the moment a _consumer_ injects a marker that doesn't form a valid comment in the target language.

There is nothing to fix or work around in `@shikijs/transformers`. Filing this upstream would not make sense.

### Finding 6: Shiki has a first-class `decorations` API that bypasses the comment-detection layer

`@shikijs/types@3.22.0` exposes `DecorationOptions` and `DecorationItem` directly on `CodeToHastOptionsCommon`:

```94:130:node_modules/.pnpm/@shikijs+types@3.22.0/node_modules/@shikijs/types/dist/index.d.mts
interface DecorationOptions {
  /**
   * Custom decorations to wrap highlighted tokens with.
   */
  decorations?: DecorationItem[];
}
interface DecorationItem {
  /**
   * Start offset or position of the decoration.
   */
  start: OffsetOrPosition;
  /**
   * End offset or position of the decoration.
   */
  end: OffsetOrPosition;
  /**
   * Tag name of the element to create.
   * @default 'span'
   */
  tagName?: string;
  /**
   * Properties of the element to create.
   */
  properties?: Element['properties'];
  /**
   * A custom function to transform the element after it has been created.
   */
  transform?: (element: Element, type: DecorationTransformType) => Element | void;
  …
}
```

`OffsetOrPosition` accepts either a numeric offset or a `{ line, character }` pair. Decorations attach classes/properties to ranges of the rendered output without going through grammar tokenization, so they are completely language-agnostic.

This is the architecturally correct surface for "I already know which lines are added/removed; just style them." Today's pipeline launders that information through synthesized comments, and the laundering only works when the language happens to support `//`. Decorations let us short-circuit the laundering entirely.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                 | Priority | Effort | Impact |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | ------ |
| R1  | Replace `linesToShikiNotation` + `transformerNotationDiff` with Shiki's `decorations` API in `DiffViewer`. Pass the original (un-annotated) source code and per-line decorations describing `diff add` / `diff remove`. Drop `diffTransformer` entirely.                                                                                                                                               | P0       | Medium | High   |
| R2  | Add a regression test in `apps/ui/app/components/code/diff-viewer.test.tsx` (or similar) that highlights a USDA snippet and asserts the rendered HTML does **not** contain the literal substring `[!code ++]` / `[!code --]`. The test must run for every registered language to catch future grammar/registration drift.                                                                              | P0       | Low    | High   |
| R3  | Once R1 lands, remove the export of `diffTransformer` from `apps/ui/app/lib/shiki.lib.ts` and its unit-test assertion in `shiki.lib.test.ts` (the transformer is no longer used).                                                                                                                                                                                                                      | P1       | Low    | Low    |
| R4  | Audit other Shiki call sites in the workspace for similar consumer-side comment-notation injection. `Grep("\\[!code")` currently matches only `diff-viewer.tsx`, so this is contained today, but encode the lesson in `apps/ui/app/lib/shiki.lib.ts` as a JSDoc warning above the (deleted) `diffTransformer` slot or wherever future authors are likely to reach for `transformerNotationDiff` again. | P2       | Low    | Low    |

### Why R1 over a quick "language-aware comment prefix" patch

A tempting smaller fix is to teach `linesToShikiNotation` about per-language comment markers (`//` for JS/TS/SCAD/KCL, `#` for USD/bash, `--` for SQL, etc.). This would work for any language that has a single-line comment, but:

- It still fails for languages with **no** line-comment syntax (stock `json`, ASCII STL).
- It still requires the marker to live at end-of-line, which collides with multi-line strings and other end-of-line context the LLM may have produced (consider USDA's `@…@` asset paths or triple-`@` raw strings — appending `# [!code ++]` would alter the parse).
- It hard-couples the diff renderer to per-grammar trivia that is upstream-owned and may drift (e.g. if we later add `python`/`yaml`/`toml` languages we have to keep the table in sync).
- It is a workaround for a problem we don't actually need to have: we already computed the diff ourselves; we don't need Shiki to detect markers we synthesized for the sole purpose of being detected.

Decorations remove the round-trip and the language coupling in one step.

## Trade-offs

| Approach                                     | Pros                                                                     | Cons                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **A. Decorations API** (recommended)         | Language-agnostic, zero text mutation, fewer moving parts, future-proof. | Requires per-line offset accounting (line-start / line-end positions) — straightforward but new code.                       |
| **B. Language-aware comment prefix**         | Smallest diff to ship.                                                   | Doesn't cover languages with no line-comment syntax; introduces a per-language map that drifts.                             |
| **C. Custom marker-only transformer (fork)** | Reuses Shiki transformer machinery.                                      | Net new code that re-implements `parseComments` minus the comment requirement; higher maintenance burden than option A.     |
| **D. Pre/post string-replace `[!code …]`**   | One-line fix.                                                            | Strips the markers but leaves the grammar's incorrect tokenization behind, so styling never gets applied — _worst of both_. |

## Code Examples

### Reproduction (current behaviour)

Every line of an added USDA region looks like this in the rendered DOM:

```html
<span class="line">
  <span style="color:#…">defaultPrim</span>
  <span style="color:#…"> = </span>
  <span style="color:#…">"World"</span>
  <span style="color:#…"> </span>
  <!-- the next two spans are the *leak* -->
  <span style="color:#…">// </span>
  <span style="color:#…">[!code ++]</span>
</span>
```

There is no `class="diff add"` on the `<span class="line">`, so the green background and left border that `diff-viewer.tsx`'s Tailwind selectors target (`[&_.diff.add]:bg-success/20`, `[&_.diff.add]:border-l-success`, etc.) are never applied either — so this bug also produces a _silent_ loss of styling on top of the visible text leak.

### Sketch of the proposed fix (R1)

```typescript
import type { DecorationItem } from '@shikijs/types';

function buildDecorations(lines: DiffLine[]): DecorationItem[] {
  const decorations: DecorationItem[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.type === 'context') continue;
    decorations.push({
      start: { line: index, character: 0 },
      end: { line: index, character: line.content.length },
      properties: { class: line.type === 'added' ? 'diff add' : 'diff remove' },
      transform: (element, type) => {
        if (type === 'line') {
          // Shiki applies the class to the line element directly.
        }
      },
    });
  }
  return decorations;
}

const rawCode = lines.map((line) => line.content).join('\n');
const html = highlighter.codeToHtml(rawCode, {
  lang: language,
  theme: `github-${theme}`,
  decorations: buildDecorations(lines),
});
```

No `linesToShikiNotation`, no `diffTransformer`, no language-specific comment prefix. The Tailwind selectors in `diff-viewer.tsx` (`[&_.diff.add]:…`, `[&_.diff.remove]:…`) keep working unchanged because the class names are preserved.

## References

- Source: `apps/ui/app/components/code/diff-viewer.tsx` (`linesToShikiNotation`, `DiffViewer`)
- Source: `apps/ui/app/components/chat/chat-tool-file-operation.tsx` (`DiffPreview`)
- Source: `apps/ui/app/routes/projects_.$id/chat-message-tool-edit-file.tsx` (consumer of `CollapsibleFileOperation` with `diffStats`)
- Source: `apps/ui/app/lib/shiki.lib.ts` (`getHighlighter`, `diffTransformer`)
- Upstream: `node_modules/.pnpm/@shikijs+transformers@3.22.0/.../dist/index.mjs` (`matchers`, `parseComments`, `createCommentNotationTransformer`, `transformerNotationDiff`)
- Upstream: `node_modules/.pnpm/@shikijs+types@3.22.0/.../dist/index.d.mts` (`DecorationOptions`, `DecorationItem`, `DecorationTransformType`)
- Grammar: `apps/ui/app/lib/usd-language/usd.tmLanguage.json` (proves the absence of a `//` line-comment rule)
