---
title: 'Dialog vs Inline Editing Audit'
description: 'Comprehensive audit of all modal dialog usage for editing tasks across the Tau UI, with recommendations to migrate to inline patterns.'
status: active
created: '2026-04-08'
updated: '2026-04-08'
category: audit
related:
  - docs/policy/ux-policy.md
  - docs/policy/ui-policy.md
---

# Dialog vs Inline Editing Audit

Systematic review of all `Dialog` and `AlertDialog` usage in `apps/ui` to identify instances that violate the inline-first editing principle established in the [UX Policy](../policy/ux-policy.md).

## Executive Summary

The audit found **6 dialog/modal usage sites** across the application. Of these, **2 are policy violations** (single-field edits in modal dialogs), **1 is a structural anti-pattern** (nested dialog), and **3 are appropriate uses**. Existing inline patterns (`InlineTextEditor`, file tree rename, nav-history rename, popover rename) demonstrate the target approach is already well-established in the codebase.

## Problem Statement

Modal dialogs were used inconsistently for editing tasks — some surfaces use inline editing (file tree rename, nav sidebar rename, project library rename) while others use modal dialogs for equivalent single-field operations (chat rename). This inconsistency confuses both users and AI agents authoring new features. The audit catalogs every instance to prioritize migration.

## Methodology

1. Searched `apps/ui` for all imports of `Dialog`, `DialogContent`, `AlertDialog`, `AlertDialogContent` from component primitives
2. Classified each usage by task complexity (single-field, multi-field, confirmation)
3. Cross-referenced against existing inline editing patterns to identify the target migration
4. Assessed severity based on frequency of user interaction and disruption level

## Findings

### Inventory: All Dialog/AlertDialog Usage Sites

| #   | File                                                        | Lines     | Type              | Task                            | Fields                | Violation?             |
| --- | ----------------------------------------------------------- | --------- | ----------------- | ------------------------------- | --------------------- | ---------------------- |
| D1  | `routes/projects_.$id/chat-history-selector.tsx`            | 303-330   | `Dialog`          | Rename chat                     | 1 (name)              | **Yes**                |
| D2  | `routes/projects_.$id_.preview/project-settings-dialog.tsx` | 63-123    | `Dialog`          | Edit project name + description | 2 (name, description) | Borderline             |
| D3  | `routes/projects_.$id_.preview/project-settings-dialog.tsx` | 126-148   | `Dialog` (nested) | Delete project confirmation     | 0 (confirm)           | **Yes** (anti-pattern) |
| D4  | `routes/projects_.$id/chat-editor-file-tree.tsx`            | 1024-1048 | `AlertDialog`     | Delete file/folder              | 0 (confirm)           | No                     |
| D5  | `routes/projects_.library/route.tsx`                        | 689-720   | `AlertDialog`     | Bulk delete projects            | 0 (confirm + list)    | No                     |
| D6  | `components/nav/nav-bug-report-dialog.tsx`                  | 103-213   | `Dialog`          | Bug report form                 | 5+                    | No                     |

Additional non-editing dialog usage (excluded from remediation scope):

- `components/settings/settings-dialog.tsx` — Full settings panel (legitimate)
- `components/ui/image-preview.tsx` / `image-preview-group.tsx` — Media lightbox (legitimate)
- `components/ui/command.tsx` — Command palette (legitimate)
- `components/cookie-consent.tsx` — Legal/consent UI (legitimate)

### Finding 1: Chat Rename Uses Modal Dialog (D1)

**File**: `routes/projects_.$id/chat-history-selector.tsx` lines 303-330

**Problem**: Renaming a chat opens a full `Dialog` with title "Rename Chat", a single `Input`, and Cancel/Save buttons. The implementation also uses `setTimeout` to focus the input — a symptom of fighting the dialog's animation lifecycle.

**Evidence**: The same codebase already has three inline rename implementations:

- `InlineTextEditor` component used in project library table and project name editor
- `nav-history.tsx` uses conditional `isEditing` state to swap `NavLink` for `<input>`
- `project-action-dropdown.tsx` uses a `Popover` with inline form

**Impact**: Chat rename is a frequent operation. The dialog obscures the chat list, forces a dismiss action, and adds ~500ms of animation overhead.

**Severity**: P1 — High frequency, simple fix, clear precedent exists.

### Finding 2: Nested Dialog Anti-Pattern (D3)

**File**: `routes/projects_.$id_.preview/project-settings-dialog.tsx` lines 126-148

**Problem**: A `Dialog` is nested inside another `Dialog`. The outer dialog is project settings; the inner dialog is delete confirmation. This creates stacked overlays, confuses focus trapping, and produces z-index conflicts.

**Evidence**: The inner dialog uses `Dialog` instead of `AlertDialog`, missing correct `role="alertdialog"` semantics for a destructive confirmation.

**Impact**: Low frequency (delete project is rare), but architecturally incorrect. Sets a bad precedent for AI-authored code.

**Severity**: P2 — Low frequency, structural anti-pattern.

### Finding 3: Project Settings Dialog Scope (D2)

**File**: `routes/projects_.$id_.preview/project-settings-dialog.tsx` lines 63-123

**Problem**: The project settings dialog contains two fields (name + description) plus a danger zone. Per UX Policy Rule 1, two related fields are acceptable in a popover or expandable section. A full-screen dialog is heavier than necessary.

**Impact**: Moderate — project settings are accessed occasionally. The dialog obscures the preview viewport.

**Severity**: P3 — Acceptable current behavior, but could improve. Consider migrating to a popover or sheet for the preview route.

### Finding 4: Appropriate AlertDialog Usage (D4, D5)

**Files**: `chat-editor-file-tree.tsx` (1024-1048), `projects_.library/route.tsx` (689-720)

**Assessment**: Both use `AlertDialog` for destructive confirmations — file deletion (irrecoverable from filesystem) and bulk project deletion (shows item list). These are correct per UX Policy Rule 4. The file tree AlertDialog includes proper `onCloseAutoFocus` handling to return focus to the tree container.

**No change recommended.**

### Finding 5: Existing Inline Patterns (Reference)

The codebase already has well-implemented inline editing that should be used as templates:

| Pattern                      | File                                        | Mechanism                                           |
| ---------------------------- | ------------------------------------------- | --------------------------------------------------- |
| `InlineTextEditor` primitive | `components/inline-text-editor.tsx`         | Reusable display/edit toggle with Enter/Escape/blur |
| File tree rename             | `chat-editor-file-tree.tsx` lines 1374-1432 | `item.isRenaming()` swaps row for input             |
| Nav sidebar rename           | `nav-history.tsx` lines 242-329             | `isEditing` conditional renders input               |
| Project action popover       | `project-action-dropdown.tsx` lines 113-133 | `Popover` with form, triggered from dropdown        |
| Pending file/folder input    | `chat-editor-file-tree.tsx` lines 1696-1904 | Always-on inline input for new items                |

## Recommendations

| #   | Action                                                                                                     | Target                           | Priority | Effort           | Impact                                            |
| --- | ---------------------------------------------------------------------------------------------------------- | -------------------------------- | -------- | ---------------- | ------------------------------------------------- |
| R1  | Replace chat rename Dialog with inline `InlineTextEditor` in the ComboBoxResponsive item row               | `chat-history-selector.tsx` D1   | P1       | Low              | High — eliminates most frequent dialog violation  |
| R2  | Replace nested delete Dialog with AlertDialog, and remove dialog nesting by closing parent first           | `project-settings-dialog.tsx` D3 | P2       | Low              | Medium — fixes anti-pattern and ARIA semantics    |
| R3  | Consider migrating project settings from Dialog to Sheet or Popover                                        | `project-settings-dialog.tsx` D2 | P3       | Medium           | Low — current UX is acceptable                    |
| R4  | For new parameter set management: use inline `InlineTextEditor` for rename, popover for save-as name entry | `chat-parameters.tsx` (new code) | P1       | N/A (greenfield) | High — establishes correct pattern from the start |
| R5  | Add UX Policy reference to `.cursor/rules/` for React component files                                      | `.cursor/rules/ux.mdc`           | P2       | Low              | Medium — guides AI during component authoring     |

## Appendix: Component Primitive Audit

| Primitive            | File                                    | Purpose                                          | Correct usage                       |
| -------------------- | --------------------------------------- | ------------------------------------------------ | ----------------------------------- |
| `Dialog`             | `components/ui/dialog.tsx`              | Multi-field forms, settings, complex content     | Settings, bug report, image preview |
| `AlertDialog`        | `components/ui/alert-dialog.tsx`        | Destructive confirmations (`role="alertdialog"`) | File delete, bulk delete            |
| `Popover`            | `components/ui/popover.tsx`             | Lightweight anchored editing (1-2 fields)        | Menu-triggered rename               |
| `InlineTextEditor`   | `components/inline-text-editor.tsx`     | Label-to-input toggle for single-field rename    | Project name, table cells           |
| `ComboBoxResponsive` | `components/ui/combobox-responsive.tsx` | Searchable selection with mobile drawer          | Chat history, model selector        |
| `Sheet`              | `components/ui/sheet.tsx`               | Side panel overlay for medium complexity         | Settings (alternative to Dialog)    |
