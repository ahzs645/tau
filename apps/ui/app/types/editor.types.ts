import type { FileStatus } from '@taucad/types';
import type { PanelId, DesktopPanelId } from '#constants/editor.constants.js';
import { allotmentPanelOrder } from '#constants/editor.constants.js';

// ============================================================================
// File Types (moved from file-explorer.machine.ts)
// ============================================================================

/**
 * Represents an open file tab in the editor.
 */
export type OpenFile = {
  path: string;
  name: string;
};

/**
 * Source of a file open event.
 * - 'user': User-initiated action (e.g., clicked on file in tree, breadcrumb, link) - should open editor panel
 * - 'machine': Programmatic action (e.g., build load, chat tool) - should not auto-open editor panel
 */
export type FileOpenSource = 'user' | 'machine';

/**
 * Represents a file or directory item in the file tree.
 */
export type FileItem = {
  id: string;
  name: string;
  path: string;
  content: Uint8Array<ArrayBuffer>;
  language?: string;
  isDirectory?: boolean;
  children?: FileItem[];
  gitStatus?: FileStatus;
};

/**
 * Panel layout state - stored per-build for persistence across page refreshes.
 */
export type PanelState = {
  /** Which panels are open (keyed by panel ID, order-independent) */
  openPanels: Record<DesktopPanelId, boolean>;
  /** Panel sizes in pixels (keyed by panel ID, order-independent) */
  panelSizes: Record<PanelId, number>;
  /** Mobile active tab ID */
  mobileActiveTab: PanelId;
};

/**
 * Convert named panel sizes object to Allotment array format.
 * Uses allotmentPanelOrder for consistent ordering.
 */
export function toAllotmentSizes(panelSizes: Record<PanelId, number>): number[] {
  return allotmentPanelOrder.map((id) => panelSizes[id]);
}

/**
 * Convert Allotment array back to named panel sizes object.
 * Uses allotmentPanelOrder for consistent mapping.
 */
export function fromAllotmentSizes(sizes: readonly number[]): Record<PanelId, number> {
  return Object.fromEntries(allotmentPanelOrder.map((id, index) => [id, sizes[index] ?? 200])) as Record<
    PanelId,
    number
  >;
}

// ============================================================================
// Editor State Types
// ============================================================================

/**
 * Editor State - Transient per-build Editor state stored separately from build data.
 *
 * This type is stored in IndexedDB and managed by the editorMachine.
 * It is decoupled from the Build type to keep the build machine clean for
 * CLI/multi-frontend reuse.
 */
export type EditorState = {
  /** Primary key, references Build.id */
  buildId: string;
  /** Open files/tabs in the editor */
  openFiles: OpenFile[];
  /** Currently active file path */
  activeFilePath: string | undefined;
  /** Last active chat ID */
  lastChatId: string | undefined;
  /** Panel layout state (open/close, sizes, mobile tab) */
  panelState: PanelState;
  /** Timestamp of last update */
  updatedAt: number;
};

/**
 * Input type for updating editor state.
 * The `updatedAt` field is omitted as it's automatically set by the storage layer.
 */
export type EditorStateInput = Omit<EditorState, 'updatedAt'>;
