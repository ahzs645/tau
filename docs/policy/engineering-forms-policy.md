---
title: 'Engineering Forms Policy'
description: 'Layout, alignment, and interaction rules for scientific and engineering parameter forms in Tau.'
status: active
created: '2026-04-06'
updated: '2026-04-06'
related:
  - docs/policy/ui-policy.md
  - docs/policy/accessibility-policy.md
  - docs/policy/color-policy.md
---

# Engineering Forms Policy

Internal reference for layout, alignment, and interaction patterns in Tau's engineering parameter forms — the property panels, parameter inspectors, and numeric input surfaces used for CAD model configuration.

## Rationale

Engineering forms differ from consumer web forms. Users enter precise numerical values across dozens of parameters, scan vertically for specific fields, and compare values across rows. Inconsistent input widths, ragged alignment, and unpredictable layouts break the tabular rhythm that engineers rely on for rapid comprehension. This policy codifies the layout constraints that make parameter panels feel like precision instruments rather than ad-hoc web forms.

## Rules

### 1. Two-Column Label-Value Layout

Use a two-column layout with labels on the left and controls on the right. The label column has a fixed proportional width; the control column fills the remainder.

**Why**: This mirrors property inspector panels in professional CAD and creative tools (Fusion 360, SolidWorks, Blender, Figma). It enables vertical scanning — the eye traces a single vertical axis to locate a parameter, then jumps right to its value.

CORRECT:

```
Label column (40%)    │  Control column (60%)
──────────────────────┼─────────────────────────
Width*                │  ████████  [ 30   mm]
Depth*                │  ████████  [ 20   mm]
Corner Radius*        │  ████████  [  5   mm]
```

INCORRECT:

```
Width*                [ 30   mm]
Depth*                            [ 20   mm]
Corner Radius*  [  5   mm]
```

### 2. Consistent Input Widths Within a Group

All inputs within the same parameter group must have identical widths. Do not let input width vary based on label length, value content, or flex distribution.

**Why**: Varying input widths create a ragged right edge that disrupts the tabular scanning pattern. Engineers compare values vertically — inconsistent widths force re-fixation and slow comprehension.

CORRECT:

```css
/* Fixed width for inputs, consistent across all rows */
.parameter-input {
  width: 5rem;
}
```

INCORRECT:

```css
/* flex-1 causes each input to fill remaining space differently */
.parameter-input {
  flex: 1;
}
```

### 3. Right-Align Numeric Values

Right-align numeric text inside input fields. This aligns digits by place value, making magnitude comparison instant.

**Why**: Right-alignment is the universal convention for numeric data in engineering, accounting, and scientific contexts. It aligns ones-digits vertically, so 30, 20, and 5 are immediately comparable without mental normalization.

CORRECT:

```
[   30 mm]
[   20 mm]
[    5 mm]
```

INCORRECT:

```
[30 mm   ]
[20 mm   ]
[5 mm    ]
```

### 4. Unit Indicators Are Part of the Input

Display units as an integrated suffix or adornment inside (or immediately adjacent to) the input field, not as a separate detached element. The unit indicator should have a fixed width and consistent styling across all inputs.

**Why**: Detached units create ambiguity about which value they belong to. Integrated units reduce the number of distinct visual elements per row, improving density without sacrificing clarity.

### 5. Unified Slider-Input Controls (Blender Pattern)

Numeric parameters use a single unified field that combines the slider and numeric input into one element. The field spans the full control column width with an embedded proportional fill bar. Users drag horizontally to scrub values (coarse control) and click to enter a text input for precise entry.

**Why**: A unified control eliminates the width-consistency problem entirely — every numeric parameter renders as the same full-width field. It also removes the need for responsive slider collapse (the fill bar works at any width) and reduces visual complexity from two elements to one.

Visual states:

| State    | Fill opacity | Cursor       | Value display                      |
| -------- | ------------ | ------------ | ---------------------------------- |
| Default  | ~15%         | `col-resize` | Right-aligned text + unit          |
| Hover    | ~40%         | `col-resize` | Right-aligned text + unit          |
| Dragging | ~60%         | `col-resize` | Right-aligned text (live updating) |
| Editing  | hidden       | `text`       | Editable input, right-aligned      |

Interaction model:

- **Drag** (pointer down + horizontal movement > 3px): Scrub mode — value changes proportionally to pointer delta mapped to the field's range.
- **Click** (pointer up without drag): Enter edit mode — render a text input, select all, type to replace.
- **Escape**: Revert to the value before editing began.
- **Enter** / **Blur**: Commit the typed value.
- **Arrow Up/Down**: Increment/decrement by step (Shift for larger steps).

CORRECT:

```
[████████████          30 mm]   ← unified field, fill bar at ~50%
```

INCORRECT:

```
[═══slider═══] [30 mm]   ← two separate elements, inconsistent widths
```

### 6. No Focus Ring on Inline Parameter Inputs

Suppress the default focus ring (`ring-3`, `border-ring`) on parameter inputs embedded within dense form panels. The active cursor and text selection provide sufficient focus indication in a compact parameter list.

**Why**: Focus rings on individual inputs in a dense panel create excessive visual noise — the ring expands the visual footprint of a single 24px-tall field and visually disrupts adjacent rows. Standard focus rings are designed for standalone form fields, not property inspector grids.

### 7. Responsive Collapse, Not Squeeze

When container width shrinks, remove controls entirely rather than squeezing them into unusable sizes. Use container queries (`@container`) with defined breakpoints to switch between layout modes.

**Why**: A slider squeezed to 16px wide is worse than no slider — it wastes space, cannot be operated, and signals broken layout. Clean removal is always preferable to dysfunctional presence.

| Container width | Layout                                         |
| --------------- | ---------------------------------------------- |
| ≥ 280px         | Label (40%) + Unified slider-input field (60%) |
| < 280px         | Label + Unified slider-input field (stacked)   |

### 8. Fixed-Height Rows

All parameter rows must have a consistent height. Use a standard row height (`h-6` / 24px for the control area) across all parameter types: number, string, boolean, enum.

**Why**: Irregular row heights break the vertical rhythm and make the form feel unpredictable. Consistent heights enable keyboard navigation at a predictable cadence and help users estimate scroll distance.

### 9. Group Headers as Scannable Landmarks

Parameter groups use compact, uppercase section headers with item counts. Headers are collapsible. Visual nesting uses a subtle left border accent, not heavy borders or background fills.

**Why**: Engineers working with 20–50+ parameters need landmarks to jump to the relevant section. Collapsible groups let users hide irrelevant parameters. Lightweight nesting indicators preserve density.

CORRECT:

```
BASE (3)                              ▾
┃ Width*        [═══slider═══] [30 mm]
┃ Depth*        [═══slider═══] [20 mm]
┃ Corner Radius [═══slider═══] [ 5 mm]
PROFILE (7)                           ▾
┃ Line 1 X*     [═══slider═══] [ 5 mm]
```

### 10. Modified-Value Indicators Are Subtle and Non-Disruptive

When a parameter has been modified from its default, indicate it with a small dot or similar minimal marker — not a full-row highlight or bold text that disrupts the tabular rhythm.

**Why**: In a panel with 30 parameters where 25 are modified, a heavy modification indicator becomes visual noise. The indicator should be noticeable on scan but not dominate the layout.

### 11. Monospace for Units, Proportional for Labels

Use a monospace font for unit indicators and numeric values where digit alignment matters. Use the standard proportional font for labels and descriptions.

**Why**: Monospace ensures digits and unit strings occupy consistent widths, maintaining column alignment. Proportional fonts improve readability for natural-language labels.

### 12. Keyboard-First Interaction

Support full keyboard navigation: Tab between fields, Arrow Up/Down to increment/decrement values, Enter to commit, Escape to revert. Support Shift+Arrow for larger step increments.

**Why**: Engineers frequently enter sequences of values rapidly. Mouse-only interaction forces hand transitions that slow data entry. Keyboard-first interaction is the standard in professional engineering tools.

## Anti-Patterns

| Anti-pattern                               | Problem                                                                             | Correct approach                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------- |
| Separate slider + input pair               | Two elements with different widths; inconsistent sizing; responsive collapse needed | Unified slider-input field (Blender pattern) |
| `flex-1` on inputs in a label-value layout | Input widths vary per row based on label length                                     | Full-width unified field or fixed `w-20`     |
| Focus ring on dense inline inputs          | Visual noise in compact panels                                                      | Suppress ring; cursor provides focus cue     |
| Floating labels                            | Accessibility issues; label disappears on focus                                     | Static labels in left column                 |
| Placeholder as label                       | Disappears on input; fails WCAG                                                     | Persistent visible labels                    |
| Color-only state indication                | Fails color-blind users                                                             | Combine shape (dot) with position            |
| Variable row heights                       | Breaks vertical scanning rhythm                                                     | Fixed `h-6` for all control rows             |

## Summary Checklist

- [ ] Two-column label-value layout with consistent proportions
- [ ] All numeric inputs use the unified slider-input field (full width)
- [ ] Numeric values right-aligned inside inputs
- [ ] Unit indicators integrated into inputs with fixed width
- [ ] Fill bar embedded in unified control works at all widths
- [ ] No focus ring on inline parameter inputs
- [ ] Consistent row height across all parameter types
- [ ] Group headers are collapsible with item counts
- [ ] Modified-value indicator is minimal (dot, not highlight)
- [ ] Keyboard navigation: Tab, Arrow, Enter, Escape, Shift+Arrow
- [ ] Monospace font for units, proportional for labels

## References

- Siemens Industrial Experience: [Number Input](https://ix.siemens.io/docs/components/input-number/guide) — engineering-grade number input design system
- Luke Wroblewski: label placement eye-tracking research
- Nielsen Norman Group: form design guidelines
- Related: `docs/policy/ui-policy.md`
- Related: `docs/policy/accessibility-policy.md`
