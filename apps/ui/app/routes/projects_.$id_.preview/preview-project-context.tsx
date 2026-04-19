import { createContext, useContext } from 'react';
import type { Project } from '@taucad/types';

/**
 * Context for project metadata in the preview route.
 * Populated from the static project object (for sample projects) or loaded from storage (for dynamic projects).
 *
 * Extracted to a separate file to avoid module identity issues with React Router's
 * route module loading system, which can cause `createContext()` objects defined in
 * route files to differ between the framework's module instance and regular imports.
 */
export type PreviewProjectContextValue = {
  project: Project | undefined;
  isStaticProject: boolean;
  staticProjectFiles: Record<string, { content: Uint8Array<ArrayBuffer> }> | undefined;
  updateName: (name: string) => void;
  updateDescription: (description: string) => void;
};

export const PreviewProjectContext = createContext<PreviewProjectContextValue | undefined>(undefined);

export function usePreviewProject(): PreviewProjectContextValue {
  const context = useContext(PreviewProjectContext);
  if (!context) {
    throw new Error('usePreviewProject must be used within a PreviewProjectProvider');
  }

  return context;
}
