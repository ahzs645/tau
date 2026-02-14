/**
 * Monaco Model Service Provider
 *
 * React context provider that creates and orchestrates all platform services:
 * - MonacoModelService: Model lifecycle, file event handling, background sync
 * - MonacoMarkerService: Marker storage independent of model existence
 * - LanguageContributionRegistry: Two-phase language lifecycle management
 * - MonacoNavigationService: Global editor opener for cross-model navigation
 *
 * Services are initialized when Monaco becomes available and disposed on unmount.
 * Build session changes are forwarded to all services for clean state transitions.
 */

import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useMonaco } from '@monaco-editor/react';
import type { FileManagerApi } from '#machines/file-manager.machine.types.js';
import { MonacoMarkerService } from '#lib/monaco-marker-service.js';
import { MonacoModelService } from '#lib/monaco-model-service.js';
import { registry } from '#lib/monaco-language-registry.js';
import { registerMonacoNavigation } from '#lib/monaco-navigation-service.js';
import { useBuild } from '#hooks/use-build.js';
import { useFileManager } from '#hooks/use-file-manager.js';

const diagnosticsDebugPrefix = '[diag-debug]';

function diagnosticsDebugLog(scope: string, details: Record<string, unknown>): void {
  console.info(`${diagnosticsDebugPrefix} ${scope}`, details);
}

type MonacoServicesContextType = {
  modelService: MonacoModelService | undefined;
  markerService: MonacoMarkerService | undefined;
};

const defaultContextValue: MonacoServicesContextType = { modelService: undefined, markerService: undefined };

const MonacoServicesContext = createContext<MonacoServicesContextType>(defaultContextValue);

export function MonacoModelServiceProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const monaco = useMonaco();
  const { buildId, editorRef } = useBuild();
  const { fileManagerRef, readFile, exists, readdir, getDirectoryStat } = useFileManager();

  // Stable file manager API reference (methods are already useCallback-wrapped)
  const fileManagerApi = useMemo<FileManagerApi>(
    () => ({ readFile, exists, readdir, getDirectoryStat }),
    [readFile, exists, readdir, getDirectoryStat],
  );

  // State-driven so context consumers re-render when services become available
  const [services, setServices] = useState<MonacoServicesContextType>(defaultContextValue);

  // Initialize services when Monaco becomes available
  useEffect(() => {
    if (!monaco) {
      return;
    }

    const markerService = new MonacoMarkerService();
    markerService.initialize(monaco);

    const modelService = new MonacoModelService();
    modelService.initialize({
      monaco,
      fileManagerRef,
      fileManager: fileManagerApi,
      markerService,
    });

    // Phase 2: Activate all language contributions
    const handlers = registry.activate({
      monaco,
      modelService,
      markerService,
      fileManager: fileManagerApi,
      fileManagerRef,
    });

    // Register GLOBAL editor opener (public API, not per-editor)
    const openerDisposable = registerMonacoNavigation({
      monaco,
      editorRef,
      modelService,
      handlers,
    });

    setServices({ modelService, markerService });
    diagnosticsDebugLog('MonacoModelServiceProvider:init', {
      buildId,
      hasMonaco: Boolean(monaco),
    });

    return () => {
      diagnosticsDebugLog('MonacoModelServiceProvider:dispose', {
        buildId,
      });
      openerDisposable.dispose();
      registry.dispose();
      modelService.dispose();
      markerService.dispose();

      setServices(defaultContextValue);
    };
  }, [monaco, fileManagerApi, fileManagerRef, editorRef]);

  // Forward build session changes to services
  useEffect(() => {
    diagnosticsDebugLog('MonacoModelServiceProvider:build-session-change', {
      buildId,
      hasModelService: Boolean(services.modelService),
    });
    services.modelService?.setBuildSession(buildId);
    registry.onBuildSessionChange(buildId);
  }, [buildId, services.modelService]);

  return <MonacoServicesContext.Provider value={services}>{children}</MonacoServicesContext.Provider>;
}

/**
 * Hook to access the Monaco model and marker services.
 */
export function useMonacoServices(): MonacoServicesContextType {
  return useContext(MonacoServicesContext);
}
