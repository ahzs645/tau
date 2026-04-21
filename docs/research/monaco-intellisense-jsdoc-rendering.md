---
title: 'Monaco IntelliSense JSDoc Rendering Audit'
description: 'Why opencascade.js tooltips lose bullets and {@link} formatting in our Monaco editor, and how to make them render beautifully.'
status: draft
created: '2026-04-10'
updated: '2026-04-22'
category: investigation
related:
  - docs/research/occt-jsdoc-doxygen-truncation.md
---

# Monaco IntelliSense JSDoc Rendering Audit

Investigation into why the `BRepPrimAPI_MakeBox` hover tooltip displays an unbulleted indented "list", and a wider audit of how the freshly regenerated `opencascade.js` JSDoc renders in our embedded Monaco editor.

## Executive Summary

Three independent rendering problems compound into the ugly tooltip the user reported:

1. **Bullets disappear** in every Monaco hover/suggest widget because Tailwind v4 Preflight applies `ol, ul { list-style: none; padding: 0; margin: 0 }` to **every** `<ul>/<ol>` on the page, including those that markdown-it produces inside Monaco's hover content. The JSDoc emitter is doing the right thing — the cause is global CSS.
2. **`{@link Foo}` references render as literal text** (e.g., `{@link Storage_Schema}`) in our Monaco editor. Monaco's bundled `QuickInfoAdapter` ships a deliberately naïve `displayPartsToString` that just concatenates `displayPart.text`; it never converts JSDoc link parts into Markdown links the way `typescript-language-features` (the VS Code extension) does. We have **2,300** `{@link …}` emissions in `opencascade_full.d.ts` and every one of them appears as raw `{@link Foo}` in the tooltip.
3. **C++ scoped names inside `{@link …}` are mis-parsed** by TypeScript (`{@link OSD_ThreadPool::Launcher}` → `name="OSD_ThreadPool"`, `linkText="::Launcher"`). Even in environments that _do_ render the link, the visible label collapses to `OSD_ThreadPool::Launcher` only by accident; in Monaco, we again get the literal brace text.

The fix is split across two layers:

- **CSS layer (highest priority, two-line fix)**: scope a Preflight revert under `.monaco-hover, .suggest-widget, .parameter-hints-widget` so lists, blockquotes, and headings render natively inside Monaco overlays.
- **Emitter layer (`bindings.py` + `extract-docs.py`)**: prefer inline backticks over `{@link}` for non-resolvable C++ symbols, normalize `{@link}` payloads, and reflow oversized paragraphs.

A failing visual test against the live Monaco hover widget closes the loop.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [References](#references)
- [Appendix](#appendix)

## Problem Statement

The user attached a screenshot of the `BRepPrimAPI_MakeBox` IntelliSense tooltip in our embedded Monaco editor. The body reads:

> Describes functions to build parallelepiped boxes. A MakeBox object provides a framework for:
>
>     defining the construction of a box,
>     implementing the construction algorithm, and
>     consulting the result. Constructs a box such that its sides are parallel to the axes of
>     ...

Each item is indented but **no bullet glyph is shown** — the document looks like a stack of orphan continuation lines. The user asked us to find the root cause, audit the rest of the generated JSDoc for similar Monaco rendering issues, and document the path to "beautiful IntelliSense".

This investigation only covers the rendering surface (Monaco hover/suggest widgets). The upstream Doxygen → JSDoc extraction work is already covered by `docs/research/occt-jsdoc-doxygen-truncation.md`.

## Methodology

| Step | Action                                                                                                                                                                                                                                                                       | Output                                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1    | Verified emitted JSDoc in `packages/runtime/src/kernels/opencascade/wasm/opencascade_full.d.ts` and the bundled mirror in `libs/api-extractor/src/generated/opencascade/modules/opencascade.js/index.d.ts`                                                                   | Source `- ` markers and `\n\n` paragraph breaks are present and CommonMark-correct                                     |
| 2    | Wrote a TypeScript Compiler-API probe (`createLanguageService` → `getQuickInfoAtPosition`) that resolved the import binding for `BRepPrimAPI_MakeBox`, `OSD_ThreadPool`, `Storage_Data`, `Message_ProgressRange`, `GC_MakeSegment`, `Geom_BSplineCurve`, `BRepLib`, `gp_Pnt` | Captured `info.documentation` `SymbolDisplayPart[]` for each symbol                                                    |
| 3    | Reproduced Monaco's `displayPartsToString` (`parts.map(p => p.text).join('')`) directly from `node_modules/monaco-editor/esm/vs/language/typescript/languageFeatures.js` (v0.55.1)                                                                                           | Exposed how `{@link …}` parts collapse into raw braces                                                                 |
| 4    | Ran the joined Markdown string through `markdown-it@14` (the renderer Monaco uses for `IMarkdownString.value`)                                                                                                                                                               | Confirmed `<ul><li>…</li></ul>` is produced for `BRepPrimAPI_MakeBox`, so the missing bullets must be a CSS issue      |
| 5    | Inspected `node_modules/monaco-editor/esm/vs/editor/contrib/hover/browser/hover.css` and `apps/ui/app/styles/global.css`                                                                                                                                                     | Confirmed Tailwind v4 `@layer base` Preflight reset is the only `list-style` declaration that applies to the hover DOM |
| 6    | Ran `grep`/`python` audits across the 207k-line `.d.ts` to quantify pattern frequency (`{@link …}`, `::`, `@remarks`, dangling colons, paragraph length)                                                                                                                     | Quantitative table in [Appendix](#appendix)                                                                            |
| 7    | Cross-referenced known Monaco/VS Code rendering bugs (microsoft/monaco-editor #1079, #3107, #5167; microsoft/vscode #112292, #234143; microsoft/tsdoc #178) to separate "our problem" from "Monaco platform problem"                                                         | Findings 2 & 3                                                                                                         |

The probe scripts (`probe-quickinfo*.mjs`, `probe-jsdoc.mjs`, `render-md.mjs`) were transient and removed after gathering evidence.

## Findings

### Finding 1: Bullets are stripped by Tailwind v4 Preflight, not by JSDoc

The `.d.ts` source for `BRepPrimAPI_MakeBox` is well-formed CommonMark:

```text
/**
 * Describes functions to build parallelepiped boxes. A MakeBox object provides a framework for:
 *
 * - defining the construction of a box,
 * - implementing the construction algorithm, and
 * ...
 */
```

After TypeScript's JSDoc parser strips the `* ` line prefix, Monaco receives a single text-kind `SymbolDisplayPart` whose `.text` is exactly:

```text
Describes functions to build parallelepiped boxes. A MakeBox object provides a framework for:

- defining the construction of a box,
- implementing the construction algorithm, and
...
```

Running this string through `markdown-it@14` (Monaco's renderer) produces:

```html
<p>Describes functions to build parallelepiped boxes. A MakeBox object provides a framework for:</p>
<ul>
  <li>defining the construction of a box,</li>
  <li>implementing the construction algorithm, and</li>
  ...
</ul>
```

The `<ul>` and `<li>` elements **are** in the DOM. Monaco's own `hover.css` does not touch `list-style`. The only declaration that matches is in `apps/ui/app/styles/global.css` via Tailwind v4's `@layer base` Preflight ([Tailwind docs](https://tailwindcss.com/docs/preflight#lists-are-unstyled)):

```css
ol,
ul,
menu {
  list-style: none;
  margin: 0;
  padding: 0;
}
```

This declaration is global, unscoped, and outranks `revert` because it lives inside `@layer base` while Monaco's hover content has no competing user-agent declaration. The visible result is exactly what the screenshot shows: `<li>` items rendered as flush paragraphs with no bullet markers.

**Status**: ROOT CAUSE confirmed. Two-line CSS fix proposed in R1.

### Finding 2: `{@link Foo}` displays as literal braces in Monaco hovers

Monaco-editor's `QuickInfoAdapter.provideHover` (verified in installed `monaco-editor@0.55.1`) does:

````ts
function displayPartsToString(parts) {
  return parts ? parts.map((p) => p.text).join('') : '';
}

const documentation = displayPartsToString(info.documentation);
return {
  contents: [
    { value: '```typescript\n' + signature + '\n```\n' },
    { value: documentation + (tags ? '\n\n' + tags : '') },
  ],
};
````

`info.documentation` for `OSD_ThreadPool` returns a `SymbolDisplayPart[]` like:

```json
[
  {
    "kind": "text",
    "text": "Class defining a thread pool…\n\n- Thread pool can be used either by multi-threaded algorithm by creating "
  },
  { "kind": "link", "text": "{@link " },
  { "kind": "linkName", "text": "OSD_ThreadPool" },
  { "kind": "linkText", "text": "::Launcher" },
  { "kind": "link", "text": "}" },
  { "kind": "text", "text": ". The functor performing a job…" }
]
```

Naïve `.text` concatenation reproduces the literal token `{@link OSD_ThreadPool::Launcher}` in the output Markdown string. Markdown-it then renders that as plain text — the user sees raw braces.

VS Code does **not** have this bug because `typescript-language-features` ships its own Markdown converter (`getMarkdownDocumentation` in `previewer.ts`) that explicitly turns `link` / `linkName` / `linkText` parts into `[label](command:_typescript.openJsDocLink?…)`. Monaco-editor has never adopted that converter; tracking issues stretch back to 2018 (microsoft/monaco-editor#1079).

The blast radius in our build is large:

| Pattern                                  | Count     | Example                            |
| ---------------------------------------- | --------- | ---------------------------------- |
| Total `{@link …}` emissions              | **2,300** | `{@link Storage_Schema}`           |
| Unique link targets                      | 533       | `{@link Standard_Transient}`       |
| Targets containing C++ `::`              | 3         | `{@link OSD_ThreadPool::Launcher}` |
| Top target: `{@link Standard_Transient}` | 92        | base class reference               |

Every one of these renders as raw braces in the embedded Monaco; that is the dominant visual noise in our tooltips.

**Status**: ROOT CAUSE confirmed. Multiple mitigations available (R2/R3); the cheapest is to stop emitting `{@link}` for non-exported types and use inline code spans instead.

### Finding 3: TypeScript JSDoc parser splits C++ scoped link targets

For `{@link OSD_ThreadPool::Launcher}`, TypeScript's parser stops at the first character it cannot include in an identifier. Probe output shows:

```json
{ "kind": "linkName", "text": "OSD_ThreadPool" },
{ "kind": "linkText", "text": "::Launcher" }
```

Even in tooling that _does_ convert JSDoc links to Markdown (VS Code, TypeDoc), the resulting label is `OSD_ThreadPool::Launcher` only because both parts are concatenated; the link target is `OSD_ThreadPool` (the wrong symbol — it loses the inner class). Embedded `Foo<TheItemType>` template targets like `{@link NCollection_Array1<TheItemType>}` (77 occurrences in the .d.ts) suffer the same fate.

This is a marginal count today (3 `::` and 77 templated occurrences) but every emission is a quality regression, so the emitter should normalize them.

**Status**: Confirmed. R2 covers the fix.

### Finding 4: Some paragraphs/bullets are too long for the hover viewport

Heuristic measurement of every prose line longer than 1,500 characters in `opencascade_full.d.ts`:

| Rank | Line   | Length (chars) | Symbol                                       |
| ---- | ------ | -------------- | -------------------------------------------- |
| 1    | 6655   | 2,501          | `Precision` package overview                 |
| 2    | 196671 | 2,492          | XDE assembly tool                            |
| 3    | 20779  | 2,345          | `Poly_CoherentLink` bullet                   |
| 4    | 113713 | 2,076          | `Geom_BSplineSurface` u-isoparam description |
| 5    | 19802  | 2,027          | BSpline parameterization identifier          |

A 2,500-character bullet with no internal paragraph breaks wraps across ~25 lines in Monaco's default 700px hover viewport. The screenshot illustrates the readability cliff. Most of these lines were originally a sequence of sentences in OCCT C++ headers; Doxygen joined them into one paragraph, and our extractor preserved that. Sentence-level reflow would dramatically improve scannability.

**Status**: Cosmetic. R5 covers a sentence-splitting heuristic.

### Finding 5: Dangling-colon "openers" are still common

The R5 termination test we added in the previous TDD pass enumerates a small allowlist of opener phrases ("as follows:", "such as:", …). Across the rest of the file there are **656** prose lines that end with a lowercase word + `:` — most are legitimate ("includes:", "for example:", "operations:") and immediately followed by a list, so they look fine. A handful of edge cases still produce unsatisfying tooltips when the bullet that "answers" the colon was lost upstream (e.g., when only a `<computeroutput>` followed). This is a long tail; we should not tighten the lint past the current opener allowlist without addressing the upstream Doxygen XML quirks individually.

**Status**: Acceptable. No new recommendation, but tracked for future R5 expansion.

### Finding 6: `@remarks **Note:**` and `@see {@link …}` render acceptably

Monaco's `tagToString` formats every JSDoc tag as `*@${name}* — ${text}`. For our R4 emissions:

| Source                                     | Rendered Markdown                              | Renders as                                                                |
| ------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------- |
| `@remarks **Note:** The point will be…`    | `*@remarks* — **Note:** The point will be…`    | _@remarks_ — **Note:** The point will be…                                 |
| `@remarks **Warning:** Allocates memory…`  | `*@remarks* — **Warning:** Allocates memory…`  | _@remarks_ — **Warning:** Allocates memory…                               |
| `@see {@link Message_ProgressScope}`       | `*@see* — {@link Message_ProgressScope}`       | _@see_ — `{@link Message_ProgressScope}` (literal braces — see Finding 2) |
| `@deprecated Use BRep_Tool::Range instead` | `*@deprecated* — Use BRep_Tool::Range instead` | _@deprecated_ — Use BRep_Tool::Range instead                              |

All four read fine **except** when their body contains `{@link …}` (Finding 2). Once R2 lands, `@see` renders with inline code instead of raw braces.

**Status**: Acceptable; depends on R2.

## Recommendations

| #   | Action                                                                                                                                                                                                            | Priority | Effort | Impact                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | --------------------------------------------------------------------------------------------------- |
| R1  | Add a Preflight revert scoped to Monaco overlays so `<ul>/<ol>/<blockquote>/<h*>` render natively in hover, suggest, and parameter-hint widgets                                                                   | P0       | XS     | Restores bullets immediately; one CSS block, no rebuild                                             |
| R2  | Replace `{@link Foo}` with inline-code `` `Foo` `` in the emitter for _non-exported_ OCCT symbols, and emit ``{@link Foo \| `Foo` }`` (Markdown-link-style alias) for symbols that resolve                        | P0       | M      | Eliminates 2,300 visual `{@link}` artifacts in Monaco; preserves clickable links in VS Code/TypeDoc |
| R3  | Normalize C++ scoped link targets in `extract-docs.py` (`Foo::Bar` → `Bar` for the link target, with `Foo::Bar` as alias text)                                                                                    | P1       | S      | Fixes 3 `::` + 77 templated emissions; needed only after R2                                         |
| R4  | ~~Render an "AT-A-GLANCE" Markdown header (signature + 1-line brief) before the long body, separated by `---`, mirroring TypeScript's own `lib.dom.d.ts` style~~ **RESCINDED 2026-04-22** — see status note below | P2       | S      | (rolled back)                                                                                       |
| R5  | Sentence-split prose blocks longer than 600 characters at `". (Capital)"` boundaries during `extract-docs.py::_render_para`                                                                                       | P2       | S      | Cuts the worst 5 paragraphs from 2.5k to ~400 chars each                                            |
| R6  | Add a Vitest snapshot covering the rendered HTML for 5 representative classes (with the actual Tailwind reset and the same markdown-it config Monaco uses)                                                        | P1       | M      | Prevents regressions from future emitter or CSS changes                                             |

R1 + R2 alone resolve the visible bug in the screenshot and the largest source of noise across the entire .d.ts. R3–R6 are quality improvements that compound on top.

### R4 status: RESCINDED (2026-04-22)

R4 was implemented and shipped (OCJS commit `9e54e1b`), then rolled back in commit `d453dbf` after a user-reported visual regression. The smoking gun: Monaco's `.monaco-hover hr` style at `node_modules/monaco-editor/dev/vs/editor/editor.main.css:2940-2949` sets `margin-bottom: -4px`, intentionally tucking the rule into the next block. Combined with `.monaco-hover p { margin: 8px 0 }`, this produced a 12px / 4px asymmetric gap that visibly hugged the detailed body — the divider read as a Setext-style heading underline rather than a thematic break. The original "lib.dom.d.ts uses `---`" rationale was also incorrect on inspection: `lib.dom.d.ts` contains zero `* ---` separators (its convention is bold lead-in plus trailing `[MDN Reference]` link). The emitter now relies on the implicit 16px symmetric paragraph gap Monaco already applies between two `<p>` elements; a regression guard in `repos/opencascade.js/tests/dts-docs.test.ts` asserts `* ---` does not reappear in the generated d.ts.

## Trade-offs

### R2: `{@link}` vs inline code

| Approach                                                   | Monaco rendering                                 | VS Code rendering                                        | TypeDoc rendering            | Implementation cost |
| ---------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------- | ---------------------------- | ------------------- |
| Status quo: `{@link Foo}`                                  | Literal `{@link Foo}` (ugly)                     | Clickable link "Foo" when resolved, plain "Foo" when not | Clickable link or plain      | none                |
| `` `Foo` `` (inline code)                                  | `<code>Foo</code>` (clean, theme-aware)          | `<code>Foo</code>` (no link)                             | `<code>Foo</code>` (no link) | small               |
| ``{@link Foo \| `Foo` }`` (alias-with-code)                | Literal braces (still ugly in Monaco)            | Clickable link "`Foo`"                                   | Clickable link "`Foo`"       | medium              |
| Two-pass: `{@link}` if `Foo` is exported, else `` `Foo` `` | Literal braces only for resolvable symbols (~5%) | Clickable link when resolvable, code otherwise           | Same                         | medium              |

The two-pass strategy maximises Monaco quality without sacrificing VS Code link support. The "exported" predicate is straightforward: the OCCT symbol table already knows which classes appear in the bindings (`bindings.py` walks them).

### R1: scope vs global revert

| Approach                                                                                              | Pros                    | Cons                                                                      |
| ----------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------- |
| Global `@layer base { ul, ol { list-style: revert } }`                                                | One line                | Breaks Tailwind utility patterns elsewhere (sidebar lists, command menus) |
| Scoped `.monaco-hover, .suggest-widget, .parameter-hints-widget { ul, ol, … { list-style: revert } }` | Surgical, no collateral | Slightly more CSS                                                         |
| `prose` class injection on the rendered hover content                                                 | Reuses our docs theme   | Requires hooking Monaco's `MarkdownRenderer`, which is internal API       |

We recommend the scoped revert (table row 2). It is tiny, idempotent, and additive to Tailwind's reset.

## Code Examples

### R1 — proposed CSS revert (scoped)

Add to `apps/ui/app/styles/global.css` near the existing Monaco overrides:

```css
@layer base {
  /* Restore native list/blockquote/heading rendering inside Monaco overlays.
     Tailwind v4 Preflight strips list-style globally; Monaco's hover, suggest,
     and parameter-hints widgets render JSDoc Markdown that needs them back. */
  .monaco-hover,
  .suggest-widget,
  .parameter-hints-widget {
    ul,
    ol {
      list-style: revert;
      padding-inline-start: 1.25rem;
      margin-block: 0.25rem;
    }
    li + li {
      margin-block-start: 0.125rem;
    }
    blockquote {
      border-inline-start: 2px solid var(--vscode-editorHoverWidget-border);
      padding-inline-start: 0.5rem;
      margin-block: 0.25rem;
      color: var(--vscode-descriptionForeground);
    }
    h1,
    h2,
    h3,
    h4 {
      font-weight: 600;
      margin-block: 0.5rem 0.25rem;
    }
  }
}
```

### R2 — emitter switch from `{@link}` to inline code

In `repos/opencascade.js/src/extract-docs.py::_render_text`, change the `<ref>` branch (today emits `{@link X}`) to consult an exported-symbol set built once at startup:

```python
def _render_ref(self, node: ET.Element) -> str:
    target = (node.text or "").strip()
    if not target:
        return ""
    # Strip C++ scope qualifiers for link resolution; keep them in the visible label
    label = target
    link_target = target.split("<", 1)[0].split("::")[-1]
    if link_target in self._exported_symbols:
        return f"{{@link {link_target} | `{label}`}}"
    return f"`{label}`"
```

The `_exported_symbols` set is populated from the same registry `bindings.py` already uses to decide which classes get TypeScript declarations. No new data sources required.

### R6 — snapshot test sketch

```ts
// libs/api-extractor/src/extract-opencascade-types.test.ts
import { describe, it, expect } from 'vitest';
import MarkdownIt from 'markdown-it';
import { getQuickInfoForSymbol } from './test-utils.js';

const md = new MarkdownIt({ html: false, breaks: false, linkify: true });

describe('opencascade.js Monaco hover rendering', () => {
  it.each(['BRepPrimAPI_MakeBox', 'OSD_ThreadPool', 'Storage_Data'] as const)(
    'renders %s with a bulleted list and no literal {@link}',
    (symbol) => {
      const { documentation } = getQuickInfoForSymbol(symbol);
      const html = md.render(documentation);
      expect(html).toMatch(/<ul>[\s\S]*<li>/);
      expect(html).not.toMatch(/\{@link\b/);
    },
  );
});
```

## Diagrams

### Pipeline: where each finding occurs

```
  Doxygen XML                   extract-docs.py                bindings.py
       │                              │                              │
       │ <ref>OSD_ThreadPool</ref>    │ _render_ref → "{@link OSD_ThreadPool}"
       └──────────────►◀──────────────┘ _render_para → adds "\n\n- "
                                       │
                                       ▼
                       opencascade_full.d.ts (8.4 MB)
                                       │
                                       │  addExtraLib(content, file:///node_modules/opencascade.js/index.d.ts)
                                       ▼
              monaco-editor TypeScript worker (TS LanguageService)
                                       │ getQuickInfoAtPosition
                                       ▼
              SymbolDisplayPart[] including {kind:"link"} parts
                                       │
                                       ▼
            QuickInfoAdapter.provideHover                          ◀── Finding 2: collapses link parts to "{@link …}"
                                       │
                                       ▼
              IMarkdownString { value: "<text+{@link}>" }
                                       │
                                       ▼ MarkdownRenderer → markdown-it
                                       │
                                       ▼
              <div class="monaco-hover"> <ul><li>…</li></ul> </div>
                                       │
                                       ▼  Tailwind v4 Preflight CSS    ◀── Finding 1: list-style:none
                                       ▼
                            User sees indented text, no bullets, raw {@link …}
```

## References

- microsoft/monaco-editor#1079 — Markdown in JSDoc from .d.ts treated as plain text (root issue for Monaco's link handling)
- microsoft/monaco-editor#3107 — `@example` followed by a code block breaks rendering
- microsoft/monaco-editor#5167 — `@example` + code block (regression of #3107)
- microsoft/vscode#112292 — JSDoc Markdown rendering under `@param` partially broken
- microsoft/vscode#234143 — Render JSDoc `@example` as TypeScript (merged 2024)
- microsoft/tsdoc#178 — Markdown lists in TSDoc emitter
- [Monaco-editor `languageFeatures.ts` (b8fa85f6)](https://github.com/microsoft/monaco-editor/blob/b8fa85f6/src/language/typescript/languageFeatures.ts) — source of the naïve `displayPartsToString`
- [Tailwind CSS v4 Preflight](https://tailwindcss.com/docs/preflight#lists-are-unstyled) — `list-style: none` reset documented as intentional
- Related: `docs/research/occt-jsdoc-doxygen-truncation.md` — upstream JSDoc emission audit; this document picks up where that one leaves off (rendering, not extraction)
- Related: `apps/ui/app/lib/type-acquisition-service.ts` — how the bundled types reach Monaco
- Related: `apps/ui/app/components/code/code-editor.client.tsx` — Monaco initialization, `fixedOverflowWidgets`, font overrides

## Appendix

### A1. Quantitative pattern audit (`packages/runtime/src/kernels/opencascade/wasm/opencascade_full.d.ts`, 207,474 lines / 8.4 MB)

| Pattern                                             | Count                             |
| --------------------------------------------------- | --------------------------------- |
| Total JSDoc blocks                                  | 3,237                             |
| Unordered list items (`* - `)                       | 1,837                             |
| Ordered list items (`* 1. `)                        | 67                                |
| `{@link …}` total                                   | 2,300                             |
| `{@link …}` unique targets                          | 533                               |
| `{@link …}` containing C++ `::`                     | 3                                 |
| `{@link …}` containing template `<…>`               | 77                                |
| `@remarks **Note:**`                                | 244                               |
| `@remarks **Warning:**`                             | 7                                 |
| `@see {@link …}`                                    | 12                                |
| `@deprecated …`                                     | 4                                 |
| Backticked C++ idioms (`Foo::Bar()`)                | 221                               |
| Lines ending in lowercase + `:` (potential openers) | 656                               |
| Prose lines > 1,500 chars                           | 5                                 |
| Largest single bullet                               | 2,346 chars (`Poly_CoherentLink`) |

### A2. Top 10 most-frequent `{@link}` targets

| Count | Target                                    |
| ----- | ----------------------------------------- |
| 92    | `{@link Standard_Transient}`              |
| 84    | `{@link TopoDS}`                          |
| 82    | `{@link NCollection_Array1}`              |
| 77    | `{@link NCollection_Array1<TheItemType>}` |
| 59    | `{@link Law}`                             |
| 53    | `{@link Standard}`                        |
| 40    | `{@link IGESGeom}`                        |
| 36    | `{@link Iterator}`                        |
| 34    | `{@link IGESSolid}`                       |
| 32    | `{@link TopoDS_Shape}`                    |

Of these, only `Standard_Transient`, `TopoDS_Shape`, and the templated `NCollection_Array1<TheItemType>` correspond to actually-exported TypeScript classes. Every other entry resolves to nothing in the bundled `.d.ts` and would be better served by an inline code span (R2).

### A3. Hover widget rendering pipeline (verified versions)

| Stage                       | Implementation                                                              | Version                    |
| --------------------------- | --------------------------------------------------------------------------- | -------------------------- |
| TypeScript Language Service | `node_modules/typescript`                                                   | follows `package.json`     |
| `displayPartsToString`      | `node_modules/monaco-editor/esm/vs/language/typescript/languageFeatures.js` | monaco-editor 0.55.1       |
| Markdown renderer           | Monaco internal `MarkdownRenderer` → markdown-it                            | bundled with monaco-editor |
| Hover widget DOM            | `node_modules/monaco-editor/esm/vs/editor/contrib/hover/browser/hover.css`  | monaco-editor 0.55.1       |
| Page CSS                    | `apps/ui/app/styles/global.css`                                             | Tailwind v4                |

### A4. What "beautiful IntelliSense" looks like after R1 + R2

Mock of the same `BRepPrimAPI_MakeBox` tooltip after both fixes:

```text
class BRepPrimAPI_MakeBox extends BRepBuilderAPI_MakeShape
import BRepPrimAPI_MakeBox

Describes functions to build parallelepiped boxes. A `MakeBox` object
provides a framework for:
  • defining the construction of a box,
  • implementing the construction algorithm, and
  • consulting the result.

Constructs a box such that its sides are parallel to the axes of:
  • the global coordinate system, or
  • the local coordinate system Axis,

and:
  • with a corner at (0, 0, 0) and of size (dx, dy, dz), or
  • with a corner at point P and of size (dx, dy, dz), or
  • with corners at points P1 and P2.

Exceptions
  Standard_DomainError if dx, dy, dz are less than or equal to
    Precision::Confusion(), or
  the vector joining the points P1 and P2 has a component projected
  onto the global coordinate system less than or equal to
    Precision::Confusion().
  In these cases, the box would be flat.
```

R1 restores the bullet glyphs. R2 replaces `{@link Precision::Confusion()}` with the inline-code span shown. R5 (paragraph reflow) introduces the blank lines between the introductory clause, the axis options, the size options, and the exception list.
