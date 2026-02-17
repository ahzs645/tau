import { Clipboard, Download, GalleryThumbnails, ImageDown } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { useSelector, useActorRef } from '@xstate/react';
import { createActor } from 'xstate';
import type { UIMatch } from 'react-router';
import type { ExportFormat } from '@taucad/types';
import { fileExtensionFromExportFormat } from '@taucad/types/constants';
import { useBuild, useMainGraphics } from '#hooks/use-build.js';
import { toast } from '#components/ui/sonner.js';
import { downloadBlob } from '#utils/file.utils.js';
import { screenshotRequestMachine } from '#machines/screenshot-request.machine.js';
import { exportGeometryMachine } from '#machines/export-geometry.machine.js';
import { SvgIcon } from '#components/icons/svg-icon.js';
import { Format3D } from '#components/icons/format-3d.js';
import { useCommandPaletteItems } from '#components/layout/command-palette.js';
import type { CommandPaletteItem } from '#components/layout/command-palette.js';
import { useFileManager } from '#hooks/use-file-manager.js';

export function BuildCommandPaletteItems({ match }: { readonly match: UIMatch }): undefined {
  const { compilationUnits, mainEntryFile, updateThumbnail, buildRef } = useBuild();
  const mainGraphicsRef = useMainGraphics();
  const cadActor = compilationUnits.get(mainEntryFile);
  const fileManager = useFileManager();
  const geometries = useSelector(cadActor, (state) => state?.context.geometries ?? []);
  const build = useSelector(buildRef, (state) => state.context.build);
  const buildName = useSelector(buildRef, (state) => state.context.build?.name) ?? 'file';

  const isScreenshotReady = useSelector(mainGraphicsRef, (state) => state?.context.isScreenshotReady ?? false);
  const fileCount = useSelector(fileManager.fileManagerRef, (state) => state.context.fileTree.size);

  // Create export geometry machine instance
  const exportActorRef = useActorRef(exportGeometryMachine, {
    input: { cadRef: cadActor },
  });

  // Track active screenshot actors for lifecycle cleanup
  const activeScreenshotActorsRef = useRef(new Set<{ stop: () => void }>());

  useEffect(() => {
    const actors = activeScreenshotActorsRef;
    return () => {
      for (const actor of actors.current) {
        actor.stop();
      }

      actors.current.clear();
    };
  }, []);

  const handleExport = useCallback(
    async (filename: string, format: ExportFormat) => {
      const fileExtension = fileExtensionFromExportFormat[format];
      const filenameWithExtension = `${filename}.${fileExtension}`;
      toast.promise(
        new Promise<Blob>((resolve, reject) => {
          exportActorRef.send({
            type: 'requestExport',
            format,
            onSuccess(blob) {
              downloadBlob(blob, filenameWithExtension);
              resolve(blob);
            },
            onError(error) {
              reject(new Error(error));
            },
          });
        }),
        {
          loading: `Downloading ${filenameWithExtension}...`,
          success: `Downloaded ${filenameWithExtension}`,
          error(error) {
            let message = `Failed to download ${filenameWithExtension}`;
            if (error instanceof Error) {
              message = `${message}: ${error.message}`;
            }

            return message;
          },
        },
      );
    },
    [exportActorRef],
  );

  const handleDownloadZip = useCallback(async () => {
    if (!build) {
      return;
    }

    toast.promise(
      async () => {
        // Get mechanical asset files
        const zipBlob = await fileManager.getZippedDirectory(`/builds/${build.id}`);
        return zipBlob;
      },
      {
        loading: 'Creating ZIP archive...',
        success(blob) {
          downloadBlob(blob, `${buildName}.zip`);
          return 'ZIP downloaded successfully';
        },
        error: 'Failed to create ZIP archive',
      },
    );
  }, [build, buildName, fileManager]);

  // Helper: create a screenshot actor on-demand with the current mainGraphicsRef
  const sendScreenshotRequest = useCallback(
    (event: Parameters<ReturnType<typeof createActor<typeof screenshotRequestMachine>>['send']>[0]) => {
      if (!mainGraphicsRef) {
        return;
      }

      const actor = createActor(screenshotRequestMachine, {
        input: { graphicsRef: mainGraphicsRef },
      });
      const actors = activeScreenshotActorsRef.current;
      actors.add(actor);

      // Auto-stop actor once the screenshot request completes (returns to idle after requesting)
      let sawRequesting = false;
      const subscription = actor.subscribe((snapshot) => {
        if (snapshot.value === 'requesting') {
          sawRequesting = true;
        } else if (sawRequesting) {
          subscription.unsubscribe();
          actor.stop();
          actors.delete(actor);
        }
      });

      actor.start();
      actor.send(event);
    },
    [mainGraphicsRef],
  );

  const handleDownloadPng = useCallback(
    async (filename: string) => {
      toast.promise(
        new Promise<Blob>((resolve, reject) => {
          sendScreenshotRequest({
            type: 'requestScreenshot',
            options: {
              output: {
                format: 'image/png',
                quality: 0.92,
              },
            },
            async onSuccess(dataUrls) {
              try {
                const dataUrl = dataUrls[0];
                if (!dataUrl) {
                  throw new Error('No screenshot data received');
                }

                const response = await fetch(dataUrl);
                const blob = await response.blob();
                resolve(blob);
              } catch (error) {
                reject(error instanceof Error ? error : new Error('Failed to fetch screenshot'));
              }
            },
            onError(error) {
              reject(new Error(error));
            },
          });
        }),
        {
          loading: `Downloading ${filename}...`,
          success(blob) {
            downloadBlob(blob, filename);
            return `Downloaded ${filename}`;
          },
          error(error) {
            let message = `Failed to download ${filename}`;
            if (error instanceof Error) {
              message = `${message}: ${error.message}`;
            }

            return message;
          },
        },
      );
    },
    [sendScreenshotRequest],
  );

  const updateThumbnailScreenshot = useCallback(() => {
    sendScreenshotRequest({
      type: 'requestScreenshot',
      options: {
        output: {
          format: 'image/webp',
          quality: 0.92,
        },
        zoomLevel: 1.8,
        cameraAngles: [{ phi: 60, theta: -45 }],
      },
      onSuccess(dataUrls) {
        const dataUrl = dataUrls[0];
        if (dataUrl) {
          updateThumbnail(dataUrl);
        }
      },
      onError(error) {
        console.error('Thumbnail screenshot failed:', error);
      },
    });
  }, [updateThumbnail, sendScreenshotRequest]);

  const handleUpdateThumbnail = useCallback(() => {
    toast.promise(
      async () => {
        updateThumbnailScreenshot();
      },
      {
        loading: 'Updating thumbnail...',
        success: 'Thumbnail updated',
        error: 'Failed to update thumbnail',
      },
    );
  }, [updateThumbnailScreenshot]);

  const handleCopyPngToClipboard = useCallback(async () => {
    toast.promise(
      async () => {
        return new Promise<void>((resolve, reject) => {
          sendScreenshotRequest({
            type: 'requestScreenshot',
            options: {
              output: {
                format: 'image/png',
                quality: 0.92,
                isPreview: false,
              },
            },
            async onSuccess(dataUrls) {
              try {
                const dataUrl = dataUrls[0];
                if (!dataUrl) {
                  throw new Error('No screenshot data received');
                }

                // Convert dataURL to Blob
                const response = await fetch(dataUrl);
                const blob = await response.blob();

                // Copy to clipboard
                await navigator.clipboard.write([
                  new ClipboardItem({
                    [blob.type]: blob,
                  }),
                ]);
                resolve();
              } catch (error) {
                reject(error instanceof Error ? error : new Error('Failed to copy to clipboard'));
              }
            },
            onError(error) {
              reject(new Error(error));
            },
          });
        });
      },
      {
        loading: `Copying ${buildName}.png to clipboard...`,
        success: `Copied ${buildName}.png to clipboard`,
        error: `Failed to copy ${buildName}.png to clipboard`,
      },
    );
  }, [buildName, sendScreenshotRequest]);

  // Subscribe to the cadActor to update the thumbnail when the geometries change
  useEffect(() => {
    if (!cadActor) {
      return;
    }

    const subscription = cadActor.on('geometryEvaluated', (event) => {
      if (event.geometries.length > 0) {
        updateThumbnailScreenshot();
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [updateThumbnailScreenshot, cadActor]);

  useCommandPaletteItems(
    match.id,
    (): CommandPaletteItem[] => [
      {
        id: 'download-stl',
        label: 'Download STL',
        group: 'Export',
        icon: <Format3D extension="stl" />,
        action: async () => handleExport(buildName, 'stl'),
        disabled: geometries.length === 0,
      },
      {
        id: 'download-step',
        label: 'Download STEP',
        group: 'Export',
        icon: <Format3D extension="step" />,
        action: async () => handleExport(buildName, 'step'),
        disabled: geometries.length === 0,
      },
      {
        id: 'download-gltf',
        label: 'Download GLTF',
        group: 'Export',
        icon: <SvgIcon id="gltf" />,
        action: async () => handleExport(buildName, 'gltf'),
        disabled: geometries.length === 0,
      },
      {
        id: 'download-glb',
        label: 'Download GLB',
        group: 'Export',
        icon: <SvgIcon id="gltf" />,
        action: async () => handleExport(buildName, 'glb'),
        disabled: geometries.length === 0,
      },
      {
        id: 'download-3mf',
        label: 'Download 3MF',
        group: 'Export',
        icon: <Format3D extension="3mf" />,
        action: async () => handleExport(buildName, '3mf'),
        disabled: geometries.length === 0,
      },
      {
        id: 'download-zip',
        label: 'Download ZIP',
        group: 'Code',
        icon: <Download />,
        action: handleDownloadZip,
        disabled: fileCount === 0,
      },
      {
        id: 'update-thumbnail',
        label: 'Update thumbnail',
        group: 'Preview',
        icon: <GalleryThumbnails />,
        action: handleUpdateThumbnail,
        disabled: !isScreenshotReady,
      },
      {
        id: 'copy-png',
        label: 'Copy PNG to clipboard',
        group: 'Preview',
        icon: <Clipboard />,
        action: handleCopyPngToClipboard,
        disabled: !isScreenshotReady,
        visible: import.meta.env.DEV,
      },
      {
        id: 'download-png',
        label: 'Download PNG',
        group: 'Preview',
        icon: <ImageDown />,
        action: async () => handleDownloadPng(`${buildName}.png`),
        disabled: !isScreenshotReady,
      },
    ],
    [
      handleUpdateThumbnail,
      isScreenshotReady,
      handleCopyPngToClipboard,
      handleDownloadPng,
      buildName,
      handleExport,
      geometries,
      build,
      handleDownloadZip,
    ],
  );

  return undefined;
}
