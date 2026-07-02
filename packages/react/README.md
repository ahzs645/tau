# @taucad/react

React hooks and components for `@taucad/runtime`.

## Exports

- `@taucad/react` — hooks (`useRender`).
- `@taucad/react/parameters` — `Parameters`, the JSON-Schema-driven (RJSF) parametric editor panel
  with unit-aware number fields, search, and reset-to-default tracking.
- `@taucad/react/parameters-number` — standalone unit-aware number/slider field.
- `@taucad/react/rjsf-theme` — the RJSF `widgets`/`templates`/`uiSchema` theme, for composing your
  own RJSF forms with the same field styling.
- `@taucad/react/rjsf-utils` — RJSF id helpers (`rjsfIdPrefix`, `rjsfIdSeparator`, ...).
- `@taucad/react/rjsf-context` — shared types (`Units`, `RJSFContext`).
- `@taucad/react/tooltip` — the radix tooltip wrapper used by the panel; wrap your tree in its
  `TooltipProvider`.

## Styling

Components style themselves with Tailwind utility classes over the shadcn CSS-variable theme
tokens (`--background`, `--muted`, `--primary`, `--border`, ...). Consumers must:

1. Provide those CSS variables (any shadcn-compatible theme works).
2. Include this package's source (or dist) in the Tailwind content scan, e.g. in Tailwind v4:
   `@source '../node_modules/@taucad/react/dist';`
