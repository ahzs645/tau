---
title: 'OCCT IntelliSense Truncation: Doxygen Brief/Detailed Split'
description: 'Root cause analysis of truncated JSDoc tooltips in opencascade.js .d.ts output (e.g. BRepPrimAPI_MakeBox) and recommendations to render full doxygen documentation in IntelliSense.'
status: active
created: '2026-04-21'
updated: '2026-04-21'
category: investigation
related:
  - docs/research/ocjs-additionalcppcode-type-erasure-regression.md
---

# OCCT IntelliSense Truncation: Doxygen Brief/Detailed Split

Root cause investigation of why hover tooltips for OCCT classes/methods like `BRepPrimAPI_MakeBox` show truncated, mid-sentence text in the editor, and what it would take to make them render full sentences with bullet lists, exceptions, and parameter notes.

## Executive Summary

When the user hovers `BRepPrimAPI_MakeBox` in Monaco, IntelliSense shows:

> _Describes functions to build parallelepiped boxes. A MakeBox object provides a framework for:_

The trailing colon dangles because **the bullet list and Exceptions section that originally followed the colon were silently dropped** before they ever reached the `.d.ts`. This is not a Monaco/TypeScript rendering bug — the truncated text is exactly what the generated `opencascade_full.d.ts` contains.

The root cause sits across three stages of the docs pipeline in `repos/opencascade.js`:

1. **Doxygen** correctly splits the OCCT `//!` block into `<briefdescription>` (the first paragraph) and `<detaileddescription>` (everything after the first block element — in this case the `<itemizedlist>`).
2. **`src/extract-docs.py`** stores `detailed` only on the class/enum compound entry, **not** on individual methods. Both fields are then flattened to plain text by `_description_text`, destroying list and paragraph structure.
3. **`src/bindings.py::_jsdoc`** emits only `entry.get("brief")` and `member.get("brief")` — `detailed` is never written into the generated JSDoc.

Across the current `opencascade_full.d.ts`, **~430 of 3,111 JSDoc blocks (~14%)** show evidence of truncation (256 ending in a dangling `:`, 173 ending with no terminal punctuation, 1 ending in a comma).

The fix is structural and self-contained: emit `detailed` alongside `brief` in `_jsdoc`, capture `detailed` for members in `extract-docs.py`, and replace `_description_text`'s plain-text flattener with a Doxygen-XML-to-Markdown renderer so lists, code refs, and `simplesect` tags survive into IntelliSense.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [Appendix: Truncation Inventory](#appendix-truncation-inventory)

## Problem Statement

In the editor, hovering OCCT identifiers in user code (e.g. `new BRepPrimAPI_MakeBox(p.width, p.height, p.depth)`) renders a tooltip whose description ends mid-thought:

```text
(alias) class BRepPrimAPI_MakeBox
import BRepPrimAPI_MakeBox

Describes functions to build parallelepiped boxes. A MakeBox object provides a framework for:
```

The dangling colon is unique enough to be obviously wrong — a list was supposed to follow. The user wants to know:

1. Is this a Monaco rendering bug, a TypeScript display limitation, a Doxygen extraction bug, or a `bindings.py` codegen bug?
2. Is it intentional (e.g. a deliberate "brief only" policy)?
3. What would it take to make IntelliSense always show the full doxygen comment as written in the OCCT header?

## Methodology

1. **Source-truth inspection**: Read the original OCCT header (`repos/opencascade.js/build/occt-includes/BRepPrimAPI_MakeBox.hxx`) to confirm the doxygen text actually exists upstream.
2. **Doxygen XML inspection**: Parsed the Doxygen XML output for the class compound (`build/doxygen-xml/xml/class_b_rep_prim_a_p_i___make_box.xml`) to determine how Doxygen split the comment between `<briefdescription>` and `<detaileddescription>`.
3. **Pipeline trace**: Read `src/extract-docs.py` (XML → JSON), `src/occt-docs.doxyfile` (Doxygen config), and `src/bindings.py::_jsdoc`/`_enum_member_jsdoc` (JSON → JSDoc emission).
4. **Reproduce flattening**: Imported `extract-docs.py::_description_text` against the actual `<detaileddescription>` element to confirm structural loss.
5. **Quantify scale**: Greppped `opencascade_full.d.ts` for JSDoc lines ending with `:`, lowercase letters, or commas as proxies for truncation.

## Findings

### Finding 1: OCCT source contains the full multi-paragraph comment

`BRepPrimAPI_MakeBox.hxx` lines 31–48 contain a single `//!`-block doxygen comment with an introductory sentence, a colon, a 3-item bullet list, a continuation paragraph, a 5-item enumeration of constructor variants, and a labelled "Exceptions" section.

```cpp
//! Describes functions to build parallelepiped boxes.
//! A MakeBox object provides a framework for:
//! -   defining the construction of a box,
//! -   implementing the construction algorithm, and
//! -   consulting the result.
//! Constructs a box such that its sides are parallel to the axes of
//! -   the global coordinate system, or
//! -   the local coordinate system Axis. and
//! -   with a corner at (0, 0, 0) and of size (dx, dy, dz), or
//! -   with a corner at point P and of size (dx, dy, dz), or
//! -   with corners at points P1 and P2.
//! Exceptions
//! Standard_DomainError if: dx, dy, dz are less than or equal to
//! Precision::Confusion(), or
//! -   the vector joining the points P1 and P2 has a
//! component projected onto the global coordinate
//! system less than or equal to Precision::Confusion().
//! In these cases, the box would be flat.
```

So the upstream content is intact and rich. The truncation is introduced downstream.

### Finding 2: Doxygen splits the block at the first list

With the project's `src/occt-docs.doxyfile` (`MULTILINE_CPP_IS_BRIEF = YES`, `JAVADOC_AUTOBRIEF`/`QT_AUTOBRIEF` defaulted to `NO`), Doxygen treats the leading prose as the brief description and pushes everything starting from the first block-level element (the `<itemizedlist>`) into the detailed description. The XML for `class BRepPrimAPI_MakeBox` (`build/doxygen-xml/xml/class_b_rep_prim_a_p_i___make_box.xml`, lines 449–465) shows exactly this:

```xml
<briefdescription>
<para>Describes functions to build parallelepiped boxes. A MakeBox object provides a framework for: </para>
</briefdescription>
<detaileddescription>
<para><itemizedlist>
<listitem><para>defining the construction of a box,</para></listitem>
<listitem><para>implementing the construction algorithm, and</para></listitem>
<listitem><para>consulting the result. Constructs a box such that its sides are parallel to the axes of</para></listitem>
<listitem><para>the global coordinate system, or</para></listitem>
<listitem><para>the local coordinate system Axis. and</para></listitem>
<listitem><para>with a corner at (0, 0, 0) and of size (dx, dy, dz), or</para></listitem>
<listitem><para>with a corner at point P and of size (dx, dy, dz), or</para></listitem>
<listitem><para>with corners at points P1 and P2. Exceptions Standard_DomainError if: dx, dy, dz
  are less than or equal to <ref refid="..." kindref="member">Precision::Confusion()</ref>, or</para></listitem>
<listitem><para>the vector joining the points P1 and P2 has a component projected onto the global
  coordinate system less than or equal to <ref refid="..." kindref="member">Precision::Confusion()</ref>.
  In these cases, the box would be flat. </para></listitem>
</itemizedlist></para>
</detaileddescription>
```

Doxygen's split is well-behaved and standard: the brief is the first sentence(s) of running prose, the detailed is the structured continuation. **Both fields contain valid content.**

### Finding 3: `extract-docs.py` only captures `detailed` for class compounds and enums, not methods

`src/extract-docs.py::_process_compound_xml` writes `detailed` into the JSON for `kind in ("class", "struct")` compound entries (line 119, 189) and for file-level enums (line 207). For each method's `<memberdef>`, only `brief` is captured (lines 132–141):

```python
mem_brief = _description_text(memberdef.find("briefdescription"))
mem_params = _extract_params(memberdef)
mem_returns = _extract_return(memberdef)
mem_return_type = _extract_type_text(memberdef.find("type"))
mem_deprecated = _is_deprecated(memberdef)

member_entry = {
    "kind": mem_kind,
    "brief": mem_brief,
}
```

So even if a method has a multi-paragraph comment with a `\note` / `\warning` block or a code example in its detailed section, that content is dropped at extraction time and cannot be recovered downstream.

### Finding 4: `bindings.py::_jsdoc` only emits `brief`

`src/bindings.py::_jsdoc` (lines 2161–2204) is the sole producer of class/method JSDoc in the generated `.d.ts`. For a class entry, it does:

```python
brief = self._escape_jsdoc(entry.get("brief", ""))
if not brief:
    return ""
lines = [f"{indent_str}/**"]
for line in brief.splitlines():
    lines.append(f"{indent_str} * {line}")
if entry.get("deprecated"):
    lines.append(f"{indent_str} * @deprecated")
lines.append(f"{indent_str} */")
```

There is no read of `entry.get("detailed")` anywhere in the file. The same is true for `_enum_member_jsdoc` (only `brief`) and the per-method branch (only `brief` + `params` + `returns_description`). This is the proximate cause of the dangling colon: the JSON has the detailed text for classes, but the emitter ignores it.

### Finding 5: `_description_text` flattens lists and paragraphs to a run-on string

Even when the JSON does carry `detailed` for a class, the value was produced by `_description_text` (lines 31–38), which does `ET.tostring(..., method="text")` and joins all non-empty lines with spaces. Running this against the `<detaileddescription>` of `BRepPrimAPI_MakeBox` produces:

```text
defining the construction of a box, implementing the construction algorithm, and consulting the
result. Constructs a box such that its sides are parallel to the axes of the global coordinate
system, or the local coordinate system Axis. and with a corner at (0, 0, 0) and of size (dx, dy,
dz), or with a corner at point P and of size (dx, dy, dz), or with corners at points P1 and P2.
Exceptions Standard_DomainError if: dx, dy, dz are less than or equal to Precision::Confusion(),
or the vector joining the points P1 and P2 has a component projected onto the global coordinate
system less than or equal to Precision::Confusion(). In these cases, the box would be flat.
```

All bullet-list structure is gone. So even a naive concat of `brief + " " + detailed` would yield a hard-to-read wall of text where every bullet runs into the next, and "Exceptions Standard_DomainError if:" loses its visual prominence as a section header. TSDoc / Markdown rendering in IntelliSense would not be able to recover the structure either, because the markup is no longer present in the source string.

### Finding 6: Scale of truncation

A coarse grep over the current `repos/opencascade.js/build-configs/opencascade_full.d.ts`:

| Pattern                                         | Count    | Interpretation                                                                                  |
| ----------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| Total JSDoc blocks (`^/\*\*`)                   | 3,111    | Baseline                                                                                        |
| JSDoc lines ending with `:`                     | 256      | Dangling colon — list/section was truncated                                                     |
| JSDoc lines ending with no terminal punctuation | 173      | Mid-sentence cut, e.g. "...is one of the cornerstones of Model Editor. The groundwork is to..." |
| JSDoc lines ending with `,`                     | 1        | Mid-clause cut                                                                                  |
| **Combined truncation evidence**                | **~430** | **~14% of all JSDoc blocks show observable truncation**                                         |

The true number is higher — descriptions that happen to end with a period before the cut still look "complete" but are missing the rest of the doxygen comment. So 14% is a lower bound; the upper bound is closer to "every class with a multi-paragraph or list-bearing `//!` comment in OCCT" (the bulk of OCCT's `Make*`, `Algo*`, `*_Tool`, `Geom*`, `Standard_*` headers).

### Finding 7: This is a code/data bug, not Monaco or TypeScript

Confirmed by direct inspection of the `.d.ts` source. The string between the `/**` and `*/` is exactly what Monaco shows — there is no client-side truncation. Likewise TypeScript Language Server and `tsgo` faithfully relay the full block. The fix lives entirely in `repos/opencascade.js/src/{extract-docs,bindings}.py`; no consumer change in `tau` is required.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                          | Priority | Effort | Impact                                                                                       | Status                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| R1  | Emit `detailed` alongside `brief` in `bindings.py::_jsdoc` for classes (separated by a blank `*` line so Markdown treats it as a new paragraph).                                                                                                                | P0       | Low    | Eliminates ~256 dangling-colon class tooltips immediately.                                   | ✅ IMPLEMENTED                                         |
| R2  | Capture `detailed` (and `inbodydescription` if non-empty) for **member** entries in `extract-docs.py` and emit it from `_jsdoc`'s member branch.                                                                                                                | P0       | Low    | Restores method-level extended notes (`\note`, `\warning`, code examples).                   | ✅ IMPLEMENTED                                         |
| R3  | Replace `_description_text` with a structure-aware Doxygen-XML-to-Markdown renderer that maps `<itemizedlist>` → `-`, `<para>` → blank line, `<computeroutput>` → backticks, `<ref>` → `{@link Name}`, and `<simplesect kind="...">` → headings or JSDoc tags.  | P0       | Medium | Tooltips render bullet lists, code, and section headings; cross-class refs become clickable. | ✅ IMPLEMENTED                                         |
| R4  | Map specific `<simplesect kind="...">` to first-class JSDoc tags: `note → @remarks`, `warning → @remarks` with prefix, `see → {@link}`, `return → @returns`, `deprecated → @deprecated`. Currently only `return` and `deprecated` are recognised.               | P1       | Medium | Better IntelliSense semantics; LSP "go to" works on `@see` references.                       | ✅ IMPLEMENTED                                         |
| R5  | Add a guard in `extract-docs.py` (or as a post-process check in CI) that asserts no class/method JSDoc body ends with a dangling `:`, `,`, or unbalanced opening word like `as follows`/`such as`/`including`. Fail the build with the offending compound name. | P1       | Low    | Permanent regression guard; keeps future OCCT updates honest.                                | ✅ IMPLEMENTED (as `dts-docs.test.ts` regression test) |
| R6  | Surface the **first non-empty source-file location** (`<location file="..." line="..."/>`) as a `@see` link when no `<see>` simplesect is present, so users can jump from Monaco hover to the upstream OCCT header.                                             | P2       | Low    | Nice-to-have for power users; no effect on truncation.                                       | DEFERRED — not pursued                                 |

R1 + R3 are the minimum viable fix for the reported symptom. R2 + R4 raise the bar from "first sentence only" to "full upstream doxygen comment" across all members, not just classes.

### Implementation Notes

R1–R5 landed in the `repos/opencascade.js` source pipeline and are validated by `repos/opencascade.js/tests/dts-docs.test.ts` against the regenerated `dist/opencascade_full.d.ts` (35.32 MB WASM, 8.4 MB `.d.ts`, built with `O3-wasm-exc-simd` from `build-configs/full-exceptions.yml`).

- **R1 (class detailed)** — `bindings.py::_jsdoc` now reads `entry.get("detailed")` and emits it after the brief, separated by a blank `*` line so Markdown renders the paragraph break in IntelliSense.
- **R2 (member detailed)** — `extract-docs.py::_process_compound_xml` captures `detailed`/`notes`/`warnings`/`sees` for every `<memberdef>` (including individual enum values via `_enum_member_jsdoc`), not just for compound class entries.
- **R3 (Markdown renderer)** — `extract-docs.py::_render_description` walks the Doxygen subtree producing Markdown:
  - `<para>` → paragraph (blank-line separator)
  - `<itemizedlist>`/`<orderedlist>` → `- ` / `1. ` lists
  - `<computeroutput>` → backtick-wrapped inline code
  - `<ref>` → `{@link Name}` when the target resolves to an exported symbol, plain text otherwise
  - `<simplesect>` body content extracted into structured fields rather than inlined
  - `_plain_text` was rewritten to manually walk subtree text and ignore `node.tail`, fixing a class of "trailing punctuation absorbed into inline code span" bugs (e.g., `Value().` → `Value()`.).
- **R4 (simplesect tags)** — `_extract_simplesects` lifts `<simplesect kind="note|warning|see">` out of body prose and emits them as `@remarks **Note:** …`, `@remarks **Warning:** …`, and `@see {@link Symbol}` (the latter only when the target resolves to an exported symbol; otherwise rendered as plain text). The regenerated `opencascade_full.d.ts` contains 265 such emissions.
- **R5 (regression guard)** — Implemented as a Vitest assertion in `dts-docs.test.ts` that walks every JSDoc block in the assembled `.d.ts`, identifies opener phrases (`as follows:`, `such as:`, `including:`, etc.), and fails when no substantive body content follows the opener. Two paired regressions assert the canonical `BRepPrimAPI_MakeBox` "framework for:" tooltip now renders its bullet list and that the workspace-wide truncation count stays ≤ 2 (down from ~430 baseline). Reframed from a CI guard to a test check per the implementation plan; the test runs in the standard `ocjs` test target so any future Doxygen/OCCT regression is caught locally and in CI without a separate post-build step.
- **R6 (source-file `@see`)** — Intentionally not implemented. The information is available in `<location>` elements, but the cross-link would point at fork-internal source paths rather than upstream OCCT URLs, which would invite drift; the team prefers to revisit once an authoritative upstream URL scheme is settled.

Concrete pipeline files touched:

- `repos/opencascade.js/src/extract-docs.py` — `_render_description`, `_render_para`, `_extract_simplesects`, `_plain_text` rewrite, member-detailed/enum-value capture.
- `repos/opencascade.js/src/bindings.py` — `_jsdoc` class branch, `_jsdoc` member branch, `_enum_member_jsdoc` rewrite, shared `_emit_jsdoc_text`/`_emit_simplesect_tags` helpers.
- `repos/opencascade.js/tests/dts-docs.test.ts` — 63 assertions covering R1 (class detailed), R2 (member detailed, including the multi-overload `BRepPrim_GWedge` constructor case), R3 (Markdown structure incl. bullets, code spans, paragraph breaks), R4 (`@see {@link Message_ProgressScope}` on `Message_ProgressRange`), and R5 (the `BRepPrimAPI_MakeBox` regression + workspace-wide truncation budget).
- `repos/opencascade.js/project.json` — added `dts` NX target wrapping `./build-wasm.sh dts "${OCJS_YAML}"` so `.d.ts` regeneration is a one-shot step independent of the full WASM build.
- `repos/opencascade.js/.docs-hash` — bumped to fold `extract-docs.py` SHA into the docs-cache invalidation key.

### Why _not_ change Doxygen settings instead

Disabling `MULTILINE_CPP_IS_BRIEF` or forcing `JAVADOC_AUTOBRIEF`/`QT_AUTOBRIEF` would shift _which_ part of the comment is considered brief, but would not solve the problem: as long as `_jsdoc` only emits `brief`, the unselected half of the comment is still discarded. The fix has to happen in the `extract-docs → bindings` pipeline, not in the Doxygen config.

## Trade-offs

| Concern                     | "Brief only" (today)                           | "Brief + Detailed (Markdown)" (proposed)                                                                                                                        |
| --------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.d.ts` size                | ~7.4 MB (current `opencascade_full.d.ts`)      | Estimated +5–15% (rough; depends on R3's verbosity); still well under Monaco load budget.                                                                       |
| First-paint hover latency   | Negligible                                     | Negligible — Monaco already renders Markdown lazily on hover.                                                                                                   |
| Risk of malformed JSDoc     | Low (single brief paragraph, escape `*/` only) | Slightly higher (need to escape `*/` and ensure list markers don't collide with `* ` JSDoc prefix). Mitigated by per-line `* ` indent already done in `_jsdoc`. |
| Doxygen → Markdown fidelity | n/a — no rendering                             | Excellent for `<para>`, `<itemizedlist>`, `<computeroutput>`, `<ref>`. `<formula>`/`<image>` are rare in OCCT and can be stringified or skipped.                |
| Build-time cost             | Doxygen XML parse already runs                 | Same XML parse; new code is in-process Python tree-walk with no extra I/O.                                                                                      |

## Code Examples

### Current generated output

```ts
/**
 * Describes functions to build parallelepiped boxes. A MakeBox object provides a framework for:
 */
export declare class BRepPrimAPI_MakeBox extends BRepBuilderAPI_MakeShape {
  // ...
}
```

### Output after R1 + R3 (illustrative)

```ts
/**
 * Describes functions to build parallelepiped boxes. A MakeBox object provides a framework for:
 *
 * - defining the construction of a box,
 * - implementing the construction algorithm, and
 * - consulting the result.
 *
 * Constructs a box such that its sides are parallel to the axes of
 *
 * - the global coordinate system, or
 * - the local coordinate system Axis,
 *
 * and with a corner at (0, 0, 0) and of size (dx, dy, dz), or with a corner at
 * point P and of size (dx, dy, dz), or with corners at points P1 and P2.
 *
 * **Exceptions**
 *
 * `Standard_DomainError` if `dx`, `dy`, `dz` are less than or equal to
 * {@link Precision.Confusion}, or the vector joining the points P1 and P2 has a
 * component projected onto the global coordinate system less than or equal to
 * {@link Precision.Confusion}. In these cases, the box would be flat.
 */
export declare class BRepPrimAPI_MakeBox extends BRepBuilderAPI_MakeShape {
  // ...
}
```

### Sketch of the R1 emission change in `bindings.py::_jsdoc`

```python
if member_name is None:
    brief = self._escape_jsdoc(entry.get("brief", ""))
    detailed = self._escape_jsdoc(entry.get("detailed", ""))
    if not brief and not detailed:
        return ""
    lines = [f"{indent_str}/**"]
    for line in brief.splitlines():
        lines.append(f"{indent_str} * {line}")
    if brief and detailed:
        lines.append(f"{indent_str} *")  # blank line → Markdown paragraph break
    for line in detailed.splitlines():
        lines.append(f"{indent_str} * {line}")
    if entry.get("deprecated"):
        lines.append(f"{indent_str} * @deprecated")
    lines.append(f"{indent_str} */")
    return "\n".join(lines) + "\n"
```

### Sketch of R3 — Doxygen-XML-to-Markdown renderer

```python
def _render_description(desc_element) -> str:
    """Render a Doxygen description element as Markdown.

    Maps:
      <para>            -> paragraph (blank line separator)
      <itemizedlist>    -> '- ' bullet list
      <orderedlist>     -> '1. ' numbered list
      <computeroutput>  -> `inline code`
      <ref>             -> {@link <name>}
      <simplesect kind="warning"> -> '> **Warning:** ...'
      <simplesect kind="note">    -> '> **Note:** ...'
      <simplesect kind="see">     -> '@see {@link ...}' (collected separately)
    """
    if desc_element is None:
        return ""
    out: list[str] = []
    for child in desc_element:
        if child.tag == "para":
            out.append(_render_para(child))
        elif child.tag == "itemizedlist":
            for item in child.findall("listitem"):
                inner = " ".join(_render_para(p) for p in item.findall("para"))
                out.append(f"- {inner}")
        # ... etc
    return "\n\n".join(s for s in out if s).strip()
```

The `_render_para` helper recurses on inline children (`<computeroutput>` → backticks, `<ref>` → `{@link refid}`, plain text otherwise), preserving the exact text content while adding Markdown markers.

## Appendix: Truncation Inventory

A representative slice of the 256 dangling-colon JSDoc lines (one per class) — every one of these would be repaired by R1:

| Class (truncated text — abbreviated)                                                                                              | OCCT module                 |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `BRepPrimAPI_MakeBox` — _A MakeBox object provides a framework for:_                                                              | ModelingAlgorithms/TKPrim   |
| `GeomAPI_PointsToBSpline` — _A wedge is defined by:_                                                                              | Geometry/TKGeomBase         |
| `Geom_BSplineCurve` — _Describes a BSpline curve. A BSpline curve can be:_                                                        | Geometry/TKG3d              |
| `Geom_BSplineSurface` — _Describes a BSpline surface. In each parametric direction…:_                                             | Geometry/TKG3d              |
| `BRepFilletAPI_MakeFillet` — _Contains information necessary for construction of…:_                                               | ModelingAlgorithms/TKFillet |
| `Storage_Data` — _A picture memorizing the data stored in a container. Represents either:_                                        | DataExchange/TKStorage      |
| `TDF_Attribute` — _A class each application has to implement... attached to a Label, and could be of any of the following types:_ | OCAF/TKLCAF                 |
| `Bnd_BoundSortBox` — _A tool to compare a bounding box… How to use this class:_                                                   | Mathematics/TKMath          |
| `OSD_ThreadPool` — _Class defining a thread pool... considered by the following methods:_                                         | Foundation/TKernel          |
| `TopOpeBRepDS_Filter` — _A framework for filtering computation results... output:_                                                | ModelingAlgorithms/TKBO     |

Methodology: `grep -E '^ \* [^@*].*[a-z]:$' opencascade_full.d.ts | sort -u` then sampling.

## References

- OCCT header: `repos/opencascade.js/build/occt-includes/BRepPrimAPI_MakeBox.hxx` (lines 31–48)
- Doxygen XML: `repos/opencascade.js/build/doxygen-xml/xml/class_b_rep_prim_a_p_i___make_box.xml` (lines 449–465)
- Generated `.d.ts`: `repos/opencascade.js/build-configs/opencascade_full.d.ts` (lines 66457–66460)
- Pipeline source: `repos/opencascade.js/src/extract-docs.py`, `repos/opencascade.js/src/bindings.py` (`_jsdoc`, `_enum_member_jsdoc`, `_load_docs`)
- Doxygen config: `repos/opencascade.js/src/occt-docs.doxyfile`
- Related: `docs/research/ocjs-additionalcppcode-type-erasure-regression.md` (other end of the same codegen surface)
