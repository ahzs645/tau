/**
 * Filesystem settings component.
 *
 * Allows the user to:
 * - Select the default storage backend for new builds
 * - Connect/change the workspace directory for File System (webaccess) backend
 */

import { useState, useCallback, useEffect } from 'react';
import { FolderOpen } from 'lucide-react';
import type { FilesystemBackend } from '@taucad/types';
import { Button } from '#components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '#components/ui/card.js';
import { BackendSelector } from '#components/filesystem/backend-selector.js';
import {
  storeDirectoryHandle,
  getStoredDirectoryHandle,
  checkHandlePermission,
  requestHandlePermission,
} from '#filesystem/handle-store.js';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';
import { isFileSystemAccessSupported } from '#constants/browser.constants.js';

/**
 * Filesystem settings pane for the Settings dialog.
 */
export function FilesystemSettings(): React.JSX.Element {
  const [backendCookie, setBackendCookie] = useCookie(cookieName.filesystemBackend, 'indexeddb' as FilesystemBackend);
  const [workspaceDirectoryName, setWorkspaceDirectoryName] = useState<string | undefined>(undefined);
  const [isWorkspaceConnected, setIsWorkspaceConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  // Check workspace handle status on mount
  useEffect(() => {
    const checkWorkspace = async (): Promise<void> => {
      try {
        const handle = await getStoredDirectoryHandle();
        if (handle) {
          const permission = await checkHandlePermission(handle);
          setWorkspaceDirectoryName(handle.name);
          setIsWorkspaceConnected(permission === 'granted');
        }
      } catch {
        // Handle store might not be available
      }
    };

    void checkWorkspace();
  }, []);

  const handleBackendChange = useCallback(
    (value: string) => {
      setBackendCookie(value as FilesystemBackend);
    },
    [setBackendCookie],
  );

  const handleConnectDirectory = useCallback(async () => {
    setIsConnecting(true);
    try {
      const handle = await globalThis.window.showDirectoryPicker({
        id: 'tau-workspace',
        mode: 'readwrite',
      });

      await storeDirectoryHandle(handle);
      setWorkspaceDirectoryName(handle.name);
      setIsWorkspaceConnected(true);
    } catch (error: unknown) {
      // User cancelled the directory picker
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }

      throw error;
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const handleReconnectDirectory = useCallback(async () => {
    setIsConnecting(true);
    try {
      const handle = await getStoredDirectoryHandle();
      if (!handle) {
        return;
      }

      const granted = await requestHandlePermission(handle);
      setIsWorkspaceConnected(granted);
    } finally {
      setIsConnecting(false);
    }
  }, []);

  return (
    <div className="flex flex-col gap-6 pb-6">
      {/* Default Backend */}
      <Card>
        <CardHeader>
          <CardTitle>Default Storage</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="font-medium">Default Backend</span>
              <span className="text-sm text-muted-foreground">
                Default storage for new builds. Existing builds keep their current backend.
              </span>
            </div>
            <BackendSelector isInternalHidden value={backendCookie} onSelect={handleBackendChange} />
          </div>
        </CardContent>
      </Card>

      {/* Workspace Directory (only shown when webaccess is available) */}
      {isFileSystemAccessSupported ? (
        <Card>
          <CardHeader>
            <CardTitle>Workspace Directory</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              When using the File System backend, builds are stored as subdirectories within a workspace folder on your
              computer. Pick a workspace directory to get started.
            </p>

            {workspaceDirectoryName === undefined ? (
              <Button variant="outline" className="gap-2" disabled={isConnecting} onClick={handleConnectDirectory}>
                <FolderOpen className="size-4" />
                Connect Directory
              </Button>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">{workspaceDirectoryName}</span>
                    <span className="text-xs text-muted-foreground">
                      {isWorkspaceConnected ? 'Connected' : 'Permission required'}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {!isWorkspaceConnected && (
                    <Button size="sm" variant="outline" disabled={isConnecting} onClick={handleReconnectDirectory}>
                      Grant Access
                    </Button>
                  )}
                  <Button size="sm" variant="outline" disabled={isConnecting} onClick={handleConnectDirectory}>
                    Change Directory
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ) : undefined}
    </div>
  );
}
