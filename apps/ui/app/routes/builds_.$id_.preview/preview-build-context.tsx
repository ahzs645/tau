import { createContext, useContext } from 'react';
import type { Build } from '@taucad/types';

/**
 * Context for build metadata in the preview route.
 * Populated from the static build object (for sample builds) or loaded from storage (for dynamic builds).
 *
 * Extracted to a separate file to avoid module identity issues with React Router's
 * route module loading system, which can cause `createContext()` objects defined in
 * route files to differ between the framework's module instance and regular imports.
 */
export type PreviewBuildContextValue = {
  build: Build | undefined;
  isStaticBuild: boolean;
  staticBuildFiles: Record<string, { content: Uint8Array<ArrayBuffer> }> | undefined;
  updateName: (name: string) => void;
  updateDescription: (description: string) => void;
};

export const PreviewBuildContext = createContext<PreviewBuildContextValue | undefined>(undefined);

export function usePreviewBuild(): PreviewBuildContextValue {
  const context = useContext(PreviewBuildContext);
  if (!context) {
    throw new Error('usePreviewBuild must be used within a PreviewBuildProvider');
  }

  return context;
}
