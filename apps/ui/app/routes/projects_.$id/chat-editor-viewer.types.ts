import type { editor } from 'monaco-editor';

export type ChatEditorViewerProps = {
  readonly filePath: string;
  readonly content: string;
  readonly language: string;
  readonly onChange: (value: string | undefined) => void;
  readonly onValidate: (markers: editor.IMarkerData[]) => void;
};

/**
 * Create a root-level path string for the Monaco Editor path prop.
 * Uses root-level paths (e.g., /main.ts) for consistent module resolution.
 */
export function createMonacoPath(relativePath: string): string {
  return `/${relativePath}`;
}
