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
 * Project session changes are forwarded to all services for clean state transitions.
 */

import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useMonaco } from '@monaco-editor/react';
import { MonacoMarkerService } from '#lib/monaco-marker-service.js';
import { MonacoModelService } from '#lib/monaco-model-service.js';
import { registry } from '#lib/monaco-language-registry.js';
import { registerMonacoNavigation } from '#lib/monaco-navigation-service.js';
import { useProject } from '#hooks/use-project.js';
import { useFileManager } from '#hooks/use-file-manager.js';

type MonacoServicesContextType = {
  modelService: MonacoModelService | undefined;
  markerService: MonacoMarkerService | undefined;
};

const defaultContextValue: MonacoServicesContextType = { modelService: undefined, markerService: undefined };

const MonacoServicesContext = createContext<MonacoServicesContextType>(defaultContextValue);

export function MonacoModelServiceProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const monaco = useMonaco();
  const { projectId, editorRef } = useProject();
  const { fileManagerRef, contentService, treeService, readFile, exists, readdir, getDirectoryStat } = useFileManager();

  const fileManagerApi = useMemo(
    () => ({ readFile, exists, readdir, getDirectoryStat }),
    [readFile, exists, readdir, getDirectoryStat],
  );

  const [services, setServices] = useState<MonacoServicesContextType>(defaultContextValue);

  useEffect(() => {
    if (!monaco || !contentService || !treeService) {
      return;
    }

    const markerService = new MonacoMarkerService();
    markerService.initialize(monaco);

    const modelService = new MonacoModelService();
    modelService.initialize({
      monaco,
      contentService,
      treeService,
      markerService,
    });

    const handlers = registry.activate({
      monaco,
      modelService,
      markerService,
      fileManager: fileManagerApi,
      fileManagerRef,
    });

    const openerDisposable = registerMonacoNavigation({
      monaco,
      editorRef,
      modelService,
      handlers,
    });

    setServices({ modelService, markerService });

    return () => {
      openerDisposable.dispose();
      registry.dispose();
      modelService.dispose();
      markerService.dispose();

      setServices(defaultContextValue);
    };
  }, [monaco, contentService, treeService, fileManagerApi, fileManagerRef, editorRef]);

  // Forward project session changes to services
  useEffect(() => {
    services.modelService?.setProjectSession();
    registry.onProjectSessionChange(projectId);
  }, [projectId, services.modelService]);

  return <MonacoServicesContext.Provider value={services}>{children}</MonacoServicesContext.Provider>;
}

/**
 * Hook to access the Monaco model and marker services.
 */
export function useMonacoServices(): MonacoServicesContextType {
  return useContext(MonacoServicesContext);
}
