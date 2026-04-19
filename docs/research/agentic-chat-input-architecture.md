---
title: 'Agentic Chat Input Architecture'
description: 'Research into rich text chat input UX for agentic AI — comparing libraries, analyzing Cursor reference implementation, and recommending architecture for @-mentions, slash commands, inline context tokens, drag-drop, copy-paste, and hotkeys.'
status: active
created: '2026-03-24'
updated: '2026-03-24'
category: comparison
related:
  - docs/research/context-injection-architecture.md
  - docs/research/cursor-filesystem-architecture.md
  - docs/policy/context-engineering-policy.md
  - docs/policy/filesystem-context-policy.md
---

# Agentic Chat Input Architecture

Research into building a world-class rich text chat input for Tau's agentic AI system — supporting @-mentions, slash commands, inline context tokens, drag-drop file attachment, copy-paste preservation, and custom hotkeys.

## Executive Summary

Tau's current chat input is a native `<textarea>` with manual `@` detection logic, a floating context menu, and no inline token rendering. Competing AI editors (Cursor, Windsurf, Zed) use rich text inputs where context references appear as styled, atomic inline chips that survive copy-paste and delete as single units. Analysis of three leading React rich text libraries — Tiptap (ProseMirror), Plate (Slate), and Lexical (Meta) — reveals **Tiptap** as the strongest fit for Tau's requirements: headless architecture, mature mention/slash-command extensions, React node views for custom chip rendering, FileHandler extension for drag-drop, and proven production use in AI chat interfaces. The recommended approach replaces the native `<textarea>` with a headless Tiptap editor configured as a chat input, preserving the existing toolbar, controls, and mobile/desktop split.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Finding 1: Current Implementation Audit](#finding-1-current-implementation-audit)
- [Finding 2: Cursor Reference UX Analysis](#finding-2-cursor-reference-ux-analysis)
- [Finding 3: Library Evaluation Matrix](#finding-3-library-evaluation-matrix)
- [Finding 4: Tiptap Architecture Fit](#finding-4-tiptap-architecture-fit)
- [Finding 5: Drag-Drop from Dockview Tabs](#finding-5-drag-drop-from-dockview-tabs)
- [Finding 6: Copy-Paste Token Preservation](#finding-6-copy-paste-token-preservation)
- [Finding 7: Hotkey and Command System](#finding-7-hotkey-and-command-system)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Target Architecture](#target-architecture)
- [Migration Strategy](#migration-strategy)
- [References](#references)

## Problem Statement

Tau's chat input uses a native HTML `<textarea>` element, which fundamentally cannot render inline structured elements (mention chips, file badges, slash command tokens). The current implementation:

1. **No inline tokens**: When a user selects a file via `@`, the file path is inserted as plain text — no visual distinction, no atomic deletion, no icon or badge
2. **Plain text only**: Context references blend into the surrounding text, making it hard to identify what context is attached
3. **No slash commands**: No `/` trigger for skills, commands, or mode switching within the text area
4. **No drag-drop file context**: Editor/viewer dockview tabs support drag-drop between dockviews (via `tauEditorPanelDragMime` / `tauViewerPanelDragMime`) but cannot be dropped into the chat input to attach file context
5. **Copy-paste loses structure**: There is no structure to lose — everything is already plain text
6. **Manual `@` detection**: 80+ lines of cursor-position tracking in `useChatTextareaLogic` to detect `@`, track the query, and manage the context menu state

## Methodology

1. **Current implementation audit**: Read `chat-textarea.tsx`, `chat-textarea-desktop.tsx`, `chat-textarea-mobile.tsx`, `chat-textarea-context-menu.tsx`, `chat-textarea-types.ts`, `chat-context-actions.tsx`, `chat-context-indicator.tsx` (1,400+ lines total)
2. **Dockview drag-drop audit**: Read `chat-editor-dockview.tsx` (639 lines), `chat-viewer-dockview.tsx` (602 lines), and `file.constants.ts` (MIME type definitions)
3. **Cursor UX analysis**: Examined 4 screenshots of Cursor's chat input showing @-mention dropdowns, slash command menus, inline file chips, and file tree navigation within the context menu
4. **Library research**: Evaluated Tiptap (ProseMirror), Plate (Slate), Lexical (Meta), Mentis, fude, react-rich-mentions, and Lobe Editor via documentation, GitHub repos, npm stats, and production references
5. **Competing tool analysis**: Researched Cursor, Windsurf, Zed, CLI coding agents, and GitHub Copilot chat input implementations

## Finding 1: Current Implementation Audit

### Architecture

The chat textarea system consists of 8 components:

| Component                         | Lines | Responsibility                                                      |
| --------------------------------- | ----- | ------------------------------------------------------------------- |
| `chat-textarea.tsx`               | 138   | Wrapper: mobile/desktop switch via `useIsMobile()`                  |
| `chat-textarea-types.ts`          | 627   | Shared logic hook: `useChatTextareaLogic` with all state + handlers |
| `chat-textarea-desktop.tsx`       | 411   | Desktop layout: textarea + toolbar + context menu + images          |
| `chat-textarea-mobile.tsx`        | 378   | Mobile layout: drawer-based controls                                |
| `chat-textarea-context-menu.tsx`  | 42    | Popover wrapper for `ChatContextActions` in @-mention mode          |
| `chat-context-actions.tsx`        | 593   | Screenshot/code context actions with ComboBox or popover mode       |
| `chat-context-indicator.tsx`      | 102   | SVG circular gauge for context token usage                          |
| `chat-textarea-submit-button.tsx` | ~50   | Submit/cancel button                                                |

### The `<textarea>` Element

The core input is a native `<textarea>` from the `Textarea` component (shadcn/ui):

```typescript
<Textarea
  ref={textareaReference}
  value={inputText}
  placeholder='Ask Tau to build anything...'
  onChange={handleTextChange}
  onKeyDown={handleTextareaKeyDown}
/>
```

All text is stored as `inputText: string` in the chat machine state (`draftText`). There is no structured representation of the content — context references are plain text strings concatenated into the input value.

### @-Mention Detection Logic

The `handleTextChange` handler (lines 408–462 of `chat-textarea-types.ts`) manually tracks:

- `atSymbolPosition: number` — cursor offset of the last `@` character
- `contextSearchQuery: string` — text between `@` and cursor
- `showContextMenu: boolean` — visibility of the floating context menu
- `selectedMenuIndex: number` — keyboard selection state

This logic handles edge cases (backspace through `@`, cursor movement, space-after-`@` closing) but is brittle and cannot be extended to support additional triggers like `/` without duplicating the entire detection mechanism.

### Context Menu Content

`ChatContextActions` provides:

- **Screenshots**: Current view, 6-view composite, per-view tabs
- **Code**: Code issues, kernel issues

It does NOT provide: file browsing, folder navigation, docs, terminals, past chats, branch context, or any of the categories visible in Cursor's @-mention dropdown.

### Drag-Drop Limitations

The current `handleDrop` handler in `useChatTextareaLogic` only processes `image/*` files from `event.dataTransfer.files`. It does not check for `tauEditorPanelDragMime` or `tauViewerPanelDragMime` — meaning dockview tab drags are silently ignored by the chat input.

## Finding 2: Cursor Reference UX Analysis

Analysis of 4 screenshots of Cursor's chat input reveals the following UX elements:

### @-Mention System

When the user types `@` or clicks the context button, a dropdown appears with:

| Category                | Icon            | Has submenu | Description                                |
| ----------------------- | --------------- | ----------- | ------------------------------------------ |
| Recent files            | File icon       | No          | Top 3 recently edited files with path info |
| Files & Folders         | Folder icon     | Yes         | File tree browser (nested navigation)      |
| Docs                    | Book icon       | Yes         | Documentation sources                      |
| Terminals               | Terminal icon   | Yes         | Active terminal sessions                   |
| Past Chats              | Chat icon       | Yes         | Previous conversation history              |
| Branch (Diff with Main) | Git branch icon | No          | Git diff context                           |
| Browser                 | Globe icon      | No          | Browser context                            |

The dropdown supports:

- **Real-time filtering**: Typing after `@` filters results instantly
- **Keyboard navigation**: Arrow keys + Enter for selection
- **Nested navigation**: Sub-menus for Files & Folders with full directory tree

### Inline File Chips

Selected context items appear as **styled inline badges** within the text:

- **File chips**: Rounded pill with file-type icon (gear for `.tsx`, document for `.md`) and filename
- **Atomic deletion**: Pressing Backspace once removes the entire chip
- **Color coding**: Different icon colors per file type (blue for code, red for docs)
- **Non-editable**: Chips are read-only inline nodes; cursor skips over them

### Slash Command System

Typing `/` opens a command palette with:

| Category | Examples                                                              |
| -------- | --------------------------------------------------------------------- |
| Skills   | `/create-policy`, `/create-research`, `/create-skill`, "Show 24 more" |
| Commands | `/plan`, `/ask`, `/model`, `/compress`, `/new-chat`                   |
| Custom   | User-defined commands from `.cursor/commands/`                        |

The palette shows:

- **Skill name** as the primary label
- **Description** below the name
- **"+ Add Skills"** option for discovering new skills

### Context Indicator

- **"57 Files"** collapsed badge showing total attached context count
- **"Undo All" / "Keep All" / "Review"** buttons for managing context

### Image Attachments

- Thumbnail previews above the text area
- Multiple images side-by-side

## Finding 3: Library Evaluation Matrix

| Criterion                    | Tiptap (ProseMirror)                                              | Plate (Slate)                   | Lexical (Meta)                    |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------- | --------------------------------- |
| **Weekly downloads**         | ~1.2M                                                             | ~200K                           | ~1.1M                             |
| **Bundle size**              | ~56KB                                                             | ~80KB (+ Slate)                 | ~65KB                             |
| **Architecture**             | Headless, extension-based                                         | Plugin-based, component lib     | Framework from scratch            |
| **React support**            | First-class (`@tiptap/react`)                                     | Slate-native React              | First-class                       |
| **Mention extension**        | Official `@tiptap/extension-mention`                              | `@udecode/plate-mention` plugin | Community plugins                 |
| **Slash commands**           | Official slash dropdown menu                                      | `@udecode/plate-slash-command`  | Community/manual                  |
| **Custom node views**        | React node views via `ReactNodeViewRenderer`                      | React element rendering         | `DecoratorNode`                   |
| **Inline chips/badges**      | Node views with `inline: true, atom: true`                        | Inline void elements            | Inline decorator nodes            |
| **Drag-drop file handling**  | Official `FileHandler` extension                                  | Manual implementation           | Manual implementation             |
| **Copy-paste serialization** | ProseMirror clipboard handling; known bug #4845 (fix in PR #4980) | Slate clipboard API             | Custom clipboard handling         |
| **Enter-to-submit**          | Custom extension with `addKeyboardShortcuts`                      | Event handler override          | Command listener                  |
| **Keyboard shortcuts**       | Built-in shortcut system with `addKeyboardShortcuts`              | Plugin key handlers             | `COMMAND_PRIORITY_*` system       |
| **shadcn/ui compatibility**  | Headless — use any UI                                             | Built on shadcn/ui components   | Headless — use any UI             |
| **TypeScript**               | Full                                                              | Full                            | Full                              |
| **Chat input examples**      | Novel (Tiptap-based), HuggingFace chat-ui                         | N/A (document-editor focused)   | Instagram (mentions), Lobe Editor |
| **Maturity**                 | 5+ years (ProseMirror: 8+)                                        | 4+ years (Slate: 6+)            | 3+ years                          |
| **AI toolkit**               | Official AI Toolkit for agents                                    | Copilot plugin (ghost text)     | N/A                               |
| **Maintenance**              | Active company (Tiptap GmbH)                                      | Active OSS community            | Meta (Facebook)                   |
| **Learning curve**           | Moderate                                                          | Moderate-High                   | High                              |

### Verdict

**Tiptap is the recommended choice** for Tau's agentic chat input. Rationale:

1. **Official mention + slash command extensions** reduce custom code; Plate and Lexical require more manual wiring
2. **React node views** enable fully custom chip/badge rendering with shadcn/ui components — Tau already uses shadcn/ui throughout
3. **FileHandler extension** provides built-in drag-drop file handling; Plate and Lexical require manual `onDrop` implementation
4. **Chat-input proven**: HuggingFace chat-ui migrated to Tiptap; Novel (Notion-style editor) is Tiptap-based; the Medium article on building Cursor-like @-mentions uses Tiptap
5. **Headless**: Does not impose UI opinions — Tau's existing toolbar, controls, and shadcn/ui components slot in directly
6. **Bundle efficiency**: 56KB is the lightest; acceptable given the substantial code it replaces (800+ lines of manual logic)

## Finding 4: Tiptap Architecture Fit

### Extension Map

The following Tiptap extensions map directly to Tau's requirements:

| Requirement           | Tiptap Extension                | Configuration                                            |
| --------------------- | ------------------------------- | -------------------------------------------------------- |
| Plain text editing    | `Document`, `Paragraph`, `Text` | Core extensions                                          |
| @-mention trigger     | `Mention` (official)            | `suggestion: { char: '@', items: fetchContextItems }`    |
| Slash command trigger | `Mention` variant or custom     | `suggestion: { char: '/', items: fetchCommands }`        |
| Inline file chips     | `ReactNodeViewRenderer`         | Custom `ContextChipNode` with `inline: true, atom: true` |
| Enter-to-submit       | Custom extension                | `addKeyboardShortcuts: { Enter: submitHandler }`         |
| Shift+Enter newline   | `HardBreak`                     | Default Shift+Enter behavior                             |
| Drag-drop files       | `FileHandler`                   | `onDrop: handleFileDrop`                                 |
| Image paste           | `FileHandler`                   | `onPaste: handleImagePaste`                              |
| Keyboard shortcuts    | Built-in                        | `addKeyboardShortcuts` per extension                     |
| Max height / scroll   | CSS                             | `max-h-48 overflow-auto` on editor container             |
| Placeholder           | `Placeholder` (official)        | `placeholder: 'Ask Tau to build anything...'`            |

### Custom Node: `ContextChipNode`

A custom inline atomic node for rendering context references as styled chips:

```typescript
const ContextChipNode = Node.create({
  name: 'contextChip',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      id: { default: null },
      label: { default: null },
      type: { default: 'file' }, // file | folder | doc | terminal | chat | branch
      path: { default: null },
    };
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes({ 'data-type': 'context-chip', 'data-id': HTMLAttributes.id }, HTMLAttributes),
      HTMLAttributes.label,
    ];
  },

  parseHTML() {
    return [{ tag: 'span[data-type="context-chip"]' }];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ContextChipComponent);
  },
});
```

The React component renders a shadcn/ui `Badge` with file-type icon:

```tsx
function ContextChipComponent({ node }: NodeViewProps) {
  const { label, type, path } = node.attrs;
  return (
    <NodeViewWrapper as='span' className='inline'>
      <Badge variant='secondary' className='inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs'>
        <FileTypeIcon type={type} className='size-3.5' />
        <span>{label}</span>
      </Badge>
    </NodeViewWrapper>
  );
}
```

### Multi-Trigger Suggestion System

Tiptap's `Suggestion` utility supports multiple triggers. Each trigger gets its own extension instance:

| Trigger | Extension        | Items source                                   | On select                      |
| ------- | ---------------- | ---------------------------------------------- | ------------------------------ |
| `@`     | `ContextMention` | File tree, docs, terminals, past chats, branch | Insert `ContextChipNode`       |
| `/`     | `SlashCommand`   | Skills catalog, built-in commands              | Execute command or insert chip |

The suggestion dropdown renders as a floating popover using the existing `ChatContextActions` pattern, extended with new categories.

### Content Extraction

When submitting, the editor content is serialized to a structured format:

```typescript
interface ChatInputContent {
  text: string; // Plain text with chip labels inline
  contextChips: ContextChip[]; // Structured context references
  images: string[]; // Data URLs
}
```

This replaces the current `inputText: string` with a richer model that separates free text from structured context.

## Finding 5: Drag-Drop from Dockview Tabs

### Current Dockview Drag MIME Types

From `libs/types/src/constants/file.constants.ts`:

| MIME Type                        | Source     | Payload                  |
| -------------------------------- | ---------- | ------------------------ |
| `application/x-tau-file`         | File tree  | JSON array of file paths |
| `application/x-tau-editor-panel` | Editor tab | `{ filePath: string }`   |
| `application/x-tau-viewer-panel` | Viewer tab | `{ entryFile: string }`  |

### Current Drop Handlers

- **Editor dockview**: Accepts all three MIME types → opens file in editor
- **Viewer dockview**: Accepts all three MIME types → opens file in viewer
- **Chat textarea**: Only accepts `image/*` from `event.dataTransfer.files` → ignores dockview drags

### Required Changes

The Tiptap `FileHandler` extension (or a custom drop handler via `handleDrop` in `editorProps`) should:

1. Check `event.dataTransfer` for `tauEditorPanelDragMime` or `tauViewerPanelDragMime`
2. Parse the JSON payload to extract `filePath` or `entryFile`
3. Insert a `ContextChipNode` at the drop position with the file path as the label
4. Also accept `tauFileDragMime` (file tree drags) for attaching file context

Additionally, a new MIME type `application/x-tau-chat-context` could be defined for drag-from-context-indicator scenarios.

## Finding 6: Copy-Paste Token Preservation

### The Problem

Tiptap has a known issue (#4845) where mention nodes lose their structured data on copy-paste within the same editor. The root cause: `renderHTML()` did not include `data-*` attributes needed for `parseHTML()` to reconstruct the node from clipboard HTML.

### The Fix

PR #4980 (merged) ensures data attributes are serialized. For Tau's `ContextChipNode`, the `renderHTML` method must include all identity attributes:

```typescript
renderHTML({ HTMLAttributes }) {
  return ['span', mergeAttributes({
    'data-type': 'context-chip',
    'data-id': HTMLAttributes.id,
    'data-label': HTMLAttributes.label,
    'data-chip-type': HTMLAttributes.type,
    'data-path': HTMLAttributes.path,
  }, HTMLAttributes), HTMLAttributes.label];
}
```

And `parseHTML` must extract them:

```typescript
parseHTML() {
  return [{
    tag: 'span[data-type="context-chip"]',
    getAttrs: (el) => ({
      id: el.getAttribute('data-id'),
      label: el.getAttribute('data-label'),
      type: el.getAttribute('data-chip-type'),
      path: el.getAttribute('data-path'),
    }),
  }];
}
```

This ensures that copying text containing chips and pasting it (within the same editor or across editors) preserves the chip structure.

### Cross-Application Paste

When pasting from external sources (e.g., a browser, text editor), the pasted HTML will not contain `data-type="context-chip"` spans, so tokens will not be created — they paste as plain text. This is the correct behavior.

## Finding 7: Hotkey and Command System

### Required Hotkeys

| Hotkey                     | Action                          | Current                | Proposed                                 |
| -------------------------- | ------------------------------- | ---------------------- | ---------------------------------------- |
| `Enter`                    | Submit message                  | Manual keydown handler | Tiptap keyboard shortcut                 |
| `Shift+Enter`              | New line                        | Manual keydown handler | Tiptap `HardBreak` extension             |
| `Escape`                   | Close menu / blur               | Manual keydown handler | Tiptap keyboard shortcut                 |
| `@` (typed)                | Open context menu               | Manual cursor tracking | Tiptap `Mention` suggestion trigger      |
| `/` (typed)                | Open command palette            | Not implemented        | Tiptap `SlashCommand` suggestion trigger |
| `Cmd/Ctrl+Shift+2`         | Open @ menu (Cursor convention) | Not implemented        | Tiptap keyboard shortcut → insert `@`    |
| `Cmd/Ctrl+/`               | Open / menu (Cursor convention) | Not implemented        | Tiptap keyboard shortcut → insert `/`    |
| `Cmd/Ctrl+Shift+Backspace` | Cancel stream                   | `useKeybinding` hook   | Preserved (external to editor)           |
| `Backspace` on chip        | Delete entire chip              | Not applicable         | Tiptap `atom: true` handles this         |

### Tiptap Keyboard Shortcut Registration

```typescript
const SubmitOnEnter = Extension.create({
  name: 'submitOnEnter',
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        onSubmit(extractContent(editor));
        return true;
      },
      Escape: () => {
        onEscapePressed?.();
        return true;
      },
    };
  },
});
```

### Integration with Existing Keybinding System

Tau's `useKeybinding` hook handles global shortcuts (stream cancellation). These remain external to the Tiptap editor. The editor's built-in shortcut system handles only editor-scoped shortcuts (submit, newline, triggers).

## Recommendations

| #   | Action                                                                                          | Priority | Effort | Impact                     |
| --- | ----------------------------------------------------------------------------------------------- | -------- | ------ | -------------------------- |
| R1  | Install Tiptap core + React + Mention + Suggestion + Placeholder                                | P0       | Low    | Foundation                 |
| R2  | Create `ContextChipNode` (inline atomic node with React node view)                              | P0       | Medium | Inline token rendering     |
| R3  | Replace `<Textarea>` with Tiptap editor in `chat-textarea-desktop.tsx`                          | P0       | Medium | Core migration             |
| R4  | Wire `@` trigger to expanded context menu (files, folders, docs, terminals, past chats, branch) | P0       | High   | Feature parity with Cursor |
| R5  | Wire `/` trigger to skills/command palette                                                      | P1       | Medium | Slash commands             |
| R6  | Add drop handler for `tauEditorPanelDragMime`, `tauViewerPanelDragMime`, `tauFileDragMime`      | P1       | Low    | Drag-drop file context     |
| R7  | Ensure copy-paste preservation via `data-*` attribute serialization on `ContextChipNode`        | P1       | Low    | Copy-paste fidelity        |
| R8  | Add hotkeys: `Cmd+Shift+2` (@ menu), `Cmd+/` (/ menu)                                           | P2       | Low    | Power-user UX              |
| R9  | Mirror Tiptap implementation for `chat-textarea-mobile.tsx`                                     | P2       | Medium | Mobile parity              |
| R10 | Extract structured content model (`ChatInputContent`) for submission                            | P1       | Low    | Clean API boundary         |

### R1: Tiptap Installation

```bash
pnpm install @tiptap/react @tiptap/pm @tiptap/starter-kit \
  @tiptap/extension-mention @tiptap/extension-placeholder \
  @tiptap/suggestion
```

No paid extensions are needed. All required extensions are open-source.

### R3: Textarea Replacement Strategy

The Tiptap editor replaces only the `<Textarea>` element inside `chat-textarea-desktop.tsx`. The surrounding container, toolbar (model selector, kernel selector, tool selector), context indicator, upload button, and submit button remain unchanged.

```
Before:
┌─────────────────────────────────────┐
│ <Textarea value={inputText} />      │  ← native textarea
│                                     │
│ [Model ▾] [Kernel ▾]   [@ ▾] [📎] [➤] │
└─────────────────────────────────────┘

After:
┌─────────────────────────────────────┐
│ <EditorContent editor={editor} />   │  ← Tiptap contenteditable
│  "Build a @[main.scad] with..."     │     with inline chips
│                                     │
│ [Model ▾] [Kernel ▾]   [@ ▾] [📎] [➤] │
└─────────────────────────────────────┘
```

### R4: Expanded Context Menu Categories

The `@` trigger's suggestion dropdown should provide the same categories as Cursor:

| Category        | Data source                | Implementation                              |
| --------------- | -------------------------- | ------------------------------------------- |
| Recent files    | Editor state (`openFiles`) | Query `editorRef` from `useProject()`       |
| Files & Folders | Virtual filesystem         | RPC `list_directory` with nested navigation |
| Docs            | Documentation index        | Fumadocs content index                      |
| Terminals       | N/A (future)               | Terminal session list                       |
| Past Chats      | Chat history               | `useChatHistory()` hook                     |
| Branch (Diff)   | Git state                  | N/A (future)                                |
| Screenshots     | Current implementation     | Migrate from `ChatContextActions`           |

### R6: Dockview Tab Drop Handler

```typescript
const ChatInputDropHandler = Extension.create({
  name: 'chatInputDropHandler',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDrop(view, event) {
            const editorData = event.dataTransfer?.getData(tauEditorPanelDragMime);
            const viewerData = event.dataTransfer?.getData(tauViewerPanelDragMime);
            const fileData = event.dataTransfer?.getData(tauFileDragMime);

            const filePath = editorData
              ? JSON.parse(editorData).filePath
              : viewerData
                ? JSON.parse(viewerData).entryFile
                : fileData
                  ? JSON.parse(fileData)[0]
                  : null;

            if (!filePath) return false;

            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
            if (!pos) return false;

            const node = view.state.schema.nodes.contextChip.create({
              id: filePath,
              label: basename(filePath),
              type: 'file',
              path: filePath,
            });

            view.dispatch(view.state.tr.insert(pos.pos, node));
            return true;
          },
        },
      }),
    ];
  },
});
```

## Trade-offs

| Approach                         | Pros                                                                   | Cons                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Keep `<textarea>` + overlays** | Zero new dependencies; simple mental model                             | Cannot render inline nodes; fragile cursor tracking; O(n) complexity per new trigger                    |
| **Tiptap (recommended)**         | Mature ecosystem; official extensions; proven in AI chat UIs; headless | New dependency (~56KB); learning curve for ProseMirror concepts; migration effort                       |
| **Plate (Slate)**                | shadcn/ui native; strong component library                             | Document-editor focused (not chat-input optimized); heavier bundle; less mention/slash-command maturity |
| **Lexical (Meta)**               | Built by Meta; used by Instagram                                       | Steeper learning curve; fewer official extensions; community plugins less mature                        |
| **Custom contenteditable**       | Full control; zero dependencies                                        | Enormous implementation effort; browser inconsistencies; accessibility burden                           |

## Target Architecture

### Component Hierarchy (After Migration)

```
ChatTextarea
├── ChatTextareaDesktop
│   ├── TiptapEditor (replaces <Textarea>)
│   │   ├── Document / Paragraph / Text / HardBreak
│   │   ├── ContextMention (@-trigger)
│   │   │   └── ContextSuggestionDropdown
│   │   │       ├── Recent Files
│   │   │       ├── Files & Folders (nested tree)
│   │   │       ├── Screenshots
│   │   │       ├── Code Issues
│   │   │       └── Past Chats
│   │   ├── SlashCommand (/-trigger)
│   │   │   └── CommandPaletteDropdown
│   │   │       ├── Skills (/create-policy, /create-research, ...)
│   │   │       └── Commands (/plan, /ask, /model, ...)
│   │   ├── ContextChipNode (inline atomic React node view)
│   │   ├── ChatInputDropHandler (dockview tab drops)
│   │   ├── SubmitOnEnter (keyboard shortcuts)
│   │   └── Placeholder
│   ├── ChatTextareaDesktopImages (unchanged)
│   ├── Toolbar (unchanged)
│   │   ├── ChatModelSelector
│   │   ├── ChatKernelSelector
│   │   ├── ChatToolSelector
│   │   └── ChatAgentSelector
│   ├── ChatContextIndicator (unchanged)
│   ├── ChatContextActions (@ button trigger → fires editor.commands.insertContent('@'))
│   └── ChatTextareaSubmitButton (unchanged)
└── ChatTextareaMobile (phase 2 migration)
```

### State Flow

```
User types "@mai" in Tiptap editor
    │
    ▼
Mention suggestion.items({ query: 'mai' })
    │
    ▼
Fetch + filter context items (files, folders, etc.)
    │
    ▼
Render ContextSuggestionDropdown (floating popover)
    │
    ▼
User selects "main.scad"
    │
    ▼
suggestion.command inserts ContextChipNode:
  { id: 'main.scad', label: 'main.scad', type: 'file', path: 'main.scad' }
    │
    ▼
Tiptap renders inline chip: [⚙ main.scad]
    │
    ▼
User types more text and presses Enter
    │
    ▼
SubmitOnEnter extension fires:
  extractContent(editor) → { text: "...", contextChips: [...], images: [...] }
    │
    ▼
onSubmit({ content, contextChips, images, model, metadata })
```

### Content Extraction

```typescript
function extractContent(editor: Editor): ChatInputContent {
  const doc = editor.getJSON();
  const contextChips: ContextChip[] = [];
  let text = '';

  function walk(node: JSONContent) {
    if (node.type === 'contextChip') {
      contextChips.push({
        id: node.attrs?.id,
        label: node.attrs?.label,
        type: node.attrs?.type,
        path: node.attrs?.path,
      });
      text += node.attrs?.label ?? '';
    } else if (node.type === 'text') {
      text += node.text ?? '';
    } else if (node.type === 'hardBreak') {
      text += '\n';
    }
    if (node.content) {
      for (const child of node.content) walk(child);
    }
  }

  walk(doc);
  return { text: text.trim(), contextChips, images: [] };
}
```

## Migration Strategy

### Phase 1: Core Replacement (P0)

1. Install Tiptap dependencies
2. Create `ContextChipNode` extension with React node view
3. Create `SubmitOnEnter` extension
4. Create `ChatInputDropHandler` extension
5. Replace `<Textarea>` in `chat-textarea-desktop.tsx` with `<EditorContent>`
6. Wire `@` trigger to existing `ChatContextActions` data sources
7. Update `useChatTextareaLogic` to use `editor.getHTML()` / `extractContent()` instead of `inputText`
8. Remove manual `@` detection logic (~80 lines)
9. Update submission flow to pass structured `ChatInputContent`

### Phase 2: Feature Expansion (P1)

1. Add `/` slash command trigger and palette
2. Expand `@` menu with files, folders, past chats, branch categories
3. Add nested file tree navigation in `@` dropdown
4. Add `Cmd+Shift+2` and `Cmd+/` hotkeys
5. Add context chip count indicator

### Phase 3: Mobile Parity (P2)

1. Mirror Tiptap setup in `chat-textarea-mobile.tsx`
2. Adapt suggestion dropdown for mobile drawer pattern
3. Touch-friendly chip interaction

### Removed Code

The migration removes:

- Manual `@` detection in `handleTextChange` (~55 lines)
- `atSymbolPosition`, `contextSearchQuery`, `selectedMenuIndex` state (~10 lines)
- `handleContextMenuSelect`, `handleContextImageAdd` handlers (~40 lines)
- `ChatTextareaContextMenu` component (42 lines total — replaced by Tiptap suggestion)
- Various `setShowContextMenu`, `setAtSymbolPosition`, `setContextSearchQuery` prop drilling

Estimated net reduction: ~150 lines of manual logic replaced by Tiptap extensions.

## References

- [Tiptap documentation](https://tiptap.dev/docs)
- [Tiptap Mention extension](https://tiptap.dev/api/nodes/mention)
- [Tiptap FileHandler extension](https://tiptap.dev/docs/editor/extensions/functionality/filehandler)
- [Tiptap React node views](https://tiptap.dev/docs/editor/extensions/custom-extensions/node-views/react)
- [Building @-Mention like Cursor (Medium)](https://building.theatlantic.com/building-an-mention-feature-like-cursor-in-your-website-2025-b7986d8f685d) — Tiptap-based implementation
- [HuggingFace chat-ui Tiptap migration (PR #1562)](https://github.com/huggingface/chat-ui/pull/1562)
- [Tiptap copy-paste mention fix (Issue #4845)](https://github.com/ueberdosis/tiptap/issues/4845)
- [Cursor context management strategies](https://datalakehousehub.com/blog/2026-03-context-management-cursor)
- [Cursor slash commands documentation](https://cursor.com/docs/cli/reference/slash-commands)
- Related: `docs/research/context-injection-architecture.md`
- Policy: `docs/policy/context-engineering-policy.md`
- Policy: `docs/policy/filesystem-context-policy.md`
