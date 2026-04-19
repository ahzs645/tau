---
title: 'Accessibility Policy'
description: 'Guidelines for accessible UI and ARIA-driven E2E testing across the Tau codebase. Covers semantic HTML, ARIA conventions, Playwright selector strategy, and snapshot tests.'
status: active
created: '2026-03-09'
updated: '2026-03-09'
related: []
---

# Accessibility Policy

Internal reference for accessible UI and ARIA-driven E2E testing across the Tau codebase.

## Rationale

Accessible UI ensures all users, including those using assistive technology, can interact with Tau. Using ARIA as the primary interface for E2E tests enforces accessibility compliance as a side effect of testing and keeps selectors stable across refactors.

## Principles

- Semantic HTML and ARIA attributes are the primary interface between UI components and automated tests.
- Every interactive or status-bearing element must be reachable by assistive technology.
- E2E tests must never rely on CSS classes, DOM structure, or `data-testid` attributes for element selection.

## ARIA Attribute Conventions

### Status indicators

| UI State                     | Required Attributes                                             | Example                                                             |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| Loading / in-progress        | `role="status"` `aria-label="<description>"` `aria-busy="true"` | `<div role="status" aria-label="Loading preview" aria-busy="true">` |
| Error                        | `role="alert"` `aria-label="<description>"`                     | `<div role="alert" aria-label="Preview error">`                     |
| Informational image / canvas | `role="img"` `aria-label="<description>"`                       | `<div role="img" aria-label="3D model preview">`                    |

### Interactive controls

- Buttons must have an accessible name via visible text content or `aria-label`.
- Toggle buttons must include `aria-expanded` or `aria-pressed`.
- Inputs and sliders must use native `<input>` elements with associated `<label>` or `aria-label`.

### Containers and landmarks

- Use native landmark elements (`<nav>`, `<main>`, `<aside>`) instead of generic `<div>` with `role`.
- Dialog-like surfaces (drawers, modals) must have `aria-labelledby` pointing to their title element.

## E2E Test Selector Strategy

All Playwright selectors must use Playwright's built-in accessibility locators:

```typescript
// Preferred -- accessible and resilient
page.getByRole('img', { name: /3D model preview/i });
page.getByRole('alert');
page.getByRole('button', { name: /save/i });
page.getByLabel('File name');
page.getByText('No results found');

// Forbidden in E2E tests
page.locator('.my-class');
page.locator('[data-testid="foo"]');
page.locator('div > span:nth-child(2)');
```

Rationale: accessible locators mirror how real users (and assistive technology) find elements. They remain stable across refactors and enforce accessibility compliance as a side effect of testing.

### Visual snapshot tests

Use `toHaveScreenshot` for validating rendered output that cannot be asserted via DOM (e.g. WebGL canvases):

```typescript
const canvas = page.getByRole('img', { name: /3D model preview/i });
await expect(canvas).toHaveScreenshot('model-name.png', {
  maxDiffPixelRatio: 0.02,
});
```

Snapshot baselines are stored alongside tests and updated via `npx playwright test --update-snapshots`.

## Adding Accessibility to New Components

When creating a new UI component:

1. Determine which ARIA role best describes the element (see [WAI-ARIA roles](https://www.w3.org/TR/wai-aria-1.2/#role_definitions)).
2. Add a descriptive `aria-label` (or use `aria-labelledby` to reference a visible heading).
3. For stateful components, include `aria-busy`, `aria-expanded`, `aria-pressed`, or `aria-selected` as appropriate.
4. Write E2E tests that locate the component by its ARIA role and name.

## References

- [WAI-ARIA 1.2 Specification](https://www.w3.org/TR/wai-aria-1.2/)
- [Playwright Accessibility Locators](https://playwright.dev/docs/locators#locate-by-role)
- [ARIA Authoring Practices Guide](https://www.w3.org/WAI/ARIA/apg/)
