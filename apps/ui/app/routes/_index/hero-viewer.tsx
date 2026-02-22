import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useSelector } from '@xstate/react';
import { Download, Check, ChevronDown, ArrowUpRight } from 'lucide-react';
import { exportFromGlb } from '@taucad/converter';
import type { OutputFormat } from '@taucad/converter';
import { Parameters } from '#components/geometry/parameters/parameters.js';
import { useBuildManager } from '#hooks/use-build-manager.js';
import { CadPreviewProvider, useCadPreview } from '#hooks/use-cad-preview.js';
import { CadPreviewViewer, CadPreviewStatus } from '#components/cad-preview.js';
import { Button } from '#components/ui/button.js';
import { ComboBoxResponsive } from '#components/ui/combobox-responsive.js';
import { FileExtensionIcon } from '#components/icons/file-extension-icon.js';
import { toast } from '#components/ui/sonner.js';
import { asBuffer, downloadBlob } from '#utils/file.utils.js';
import qrcodeScad from '#routes/_index/qrcode.scad?raw';
import { encodeTextFile } from '#utils/filesystem.utils.js';
import { Loader } from '#components/ui/loader.js';

const heroBuildId = 'hero-qrcode-v2';
const heroMainFile = 'main.scad';

type ExportFormatOption = {
  format: OutputFormat;
  label: string;
};

const exportFormatOptions: ExportFormatOption[] = [
  { format: 'stl', label: 'STL' },
  { format: 'step', label: 'STEP' },
  { format: 'obj', label: 'OBJ' },
  { format: 'gltf', label: 'GLTF' },
  { format: 'glb', label: 'GLB' },
  { format: 'dae', label: 'DAE' },
  { format: 'fbx', label: 'FBX' },
  { format: 'ply', label: 'PLY' },
];

function HeroViewerInner(): React.JSX.Element {
  const navigate = useNavigate();
  const { geometries, cadRef, graphicsRef, defaultParameters, jsonSchema, setParameters } = useCadPreview();
  const parameters = useSelector(cadRef, (snapshot) => snapshot.context.parameters);
  const units = useSelector(graphicsRef, (state) => state.context.units);
  const hasParameters = Boolean(jsonSchema);
  const buildManager = useBuildManager();

  const [selectedFormat, setSelectedFormat] = useState<ExportFormatOption>(exportFormatOptions[0]!);
  const [isCreatingBuild, setIsCreatingBuild] = useState(false);

  const getGlbData = useCallback((): Uint8Array<ArrayBuffer> => {
    const gltfGeometry = geometries.find((g) => g.format === 'gltf');
    if (!gltfGeometry) {
      throw new Error('No GLB geometry available. Model must be rendered first.');
    }

    return gltfGeometry.content;
  }, [geometries]);

  const handleParametersChange = useCallback(
    (newParameters: Record<string, unknown>) => {
      setParameters(newParameters);
    },
    [setParameters],
  );

  const handleExport = useCallback(() => {
    const { format } = selectedFormat;
    const filename = `qrcode.${format}`;

    toast.promise(
      (async () => {
        const glbData = getGlbData();
        const exportedFiles = await exportFromGlb(glbData, format);
        const file = exportedFiles[0];
        if (!file) {
          throw new Error('No file returned from export');
        }

        const blob = new Blob([asBuffer(file.data.buffer)]);
        downloadBlob(blob, filename);
        return blob;
      })(),
      {
        loading: `Exporting ${filename}...`,
        success: `Downloaded ${filename}`,
        error(error) {
          let message = `Failed to download ${filename}`;
          if (error instanceof Error) {
            message = `${message}: ${error.message}`;
          }

          return message;
        },
      },
    );
  }, [selectedFormat, getGlbData]);

  const handleFormatSelect = useCallback((value: string) => {
    const option = exportFormatOptions.find((o) => o.format === value);
    if (option) {
      setSelectedFormat(option);
    }
  }, []);

  const handleContinueInEditor = useCallback(async () => {
    if (isCreatingBuild) {
      return;
    }

    setIsCreatingBuild(true);

    try {
      const currentParameters = cadRef.getSnapshot().context.parameters;

      const createdBuild = await buildManager.createBuild({
        build: {
          name: 'QR Code Generator',
          description: 'A parametric QR code generator built with OpenSCAD',
          thumbnail: '/tau-desktop.jpg',
          author: {
            name: 'Community',
            avatar: '/avatar-sample.png',
          },
          tags: ['openscad', 'parametric', 'qr-code'],
          assets: {
            mechanical: {
              main: heroMainFile,
              parameters: currentParameters,
            },
          },
          forkedFrom: heroBuildId,
        },
        files: { [heroMainFile]: { content: encodeTextFile(qrcodeScad) } },
      });

      await navigate(`/builds/${createdBuild.id}`);
    } catch (error: unknown) {
      console.error('Failed to create build:', error);
      toast.error('Failed to create build');
      setIsCreatingBuild(false);
    }
  }, [isCreatingBuild, cadRef, buildManager, navigate]);

  const canExport = geometries.length > 0;

  return (
    <div className="space-y-6">
      {/* Hero Text */}
      <div className="text-center">
        <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">See It in Action</h2>
        <p className="mt-2 text-muted-foreground">
          Tweak parameters, watch the model update instantly, then export to any format.
        </p>
        <p className="mt-1 text-sm text-muted-foreground/70">Try scanning the QR code with your phone!</p>
      </div>

      <div className="flex flex-col overflow-hidden rounded-xl border bg-sidebar md:h-[700px] md:flex-row">
        {/* 3D Viewer */}
        <div className="relative h-[300px] md:h-full md:flex-1">
          <CadPreviewStatus className="top-auto right-4 bottom-4" />

          {/* Continue in Editor Button */}
          <Button
            variant="outline"
            size="sm"
            className="absolute top-2 right-2 z-10 gap-1.5 bg-background/80 backdrop-blur-sm"
            disabled={isCreatingBuild}
            onClick={handleContinueInEditor}
          >
            <span>Continue in Editor</span>
            {isCreatingBuild ? <Loader className="size-4" /> : <ArrowUpRight className="size-4" />}
          </Button>

          <CadPreviewViewer
            enablePan
            className="size-full"
            stageOptions={{ zoomLevel: 1.2 }}
            graphicsOptions={{ enableGrid: true, enableAxes: true }}
          />
        </div>

        {/* Parameters Panel */}
        {hasParameters ? (
          <div className="border-t bg-background md:w-80 md:border-t-0 md:border-l">
            <div className="flex h-full flex-col">
              <div className="border-b p-3">
                <h3 className="text-sm font-semibold">Parameters</h3>
                <p className="text-xs text-muted-foreground">Adjust the QR code settings</p>
              </div>
              <div className="h-[280px] overflow-hidden md:h-auto md:flex-1">
                <Parameters
                  isInitialExpanded={false}
                  parameters={parameters}
                  defaultParameters={defaultParameters}
                  jsonSchema={jsonSchema}
                  units={units}
                  emptyDescription="Loading parameters..."
                  onParametersChange={handleParametersChange}
                />
              </div>
              {/* Export Controls */}
              <div className="border-t p-3">
                <div className="flex items-center gap-2">
                  <ComboBoxResponsive
                    searchPlaceHolder="Search formats..."
                    title="Export Format"
                    description="Select a format to export the model"
                    groupedItems={[
                      {
                        name: 'Formats',
                        items: exportFormatOptions,
                      },
                    ]}
                    defaultValue={selectedFormat}
                    getValue={(item) => item.format}
                    renderLabel={(item, selected) => (
                      <span className="flex w-full items-center justify-between">
                        <span className="flex items-center gap-2">
                          <FileExtensionIcon filename={`file.${item.format}`} className="size-4" />
                          <span>{item.label}</span>
                        </span>
                        {selected?.format === item.format ? <Check className="size-4" /> : null}
                      </span>
                    )}
                    className="min-w-0 flex-1"
                    isSearchEnabled={false}
                    onSelect={handleFormatSelect}
                  >
                    <Button variant="outline" size="sm" className="min-w-0 grow justify-start gap-2">
                      <FileExtensionIcon filename={`file.${selectedFormat.format}`} className="size-4 shrink-0" />
                      <span className="truncate">{selectedFormat.label}</span>
                      <ChevronDown className="ml-auto size-3 shrink-0 opacity-50" />
                    </Button>
                  </ComboBoxResponsive>
                  <Button
                    size="sm"
                    className="shrink-0"
                    disabled={!canExport}
                    title={canExport ? `Download as ${selectedFormat.label}` : 'Model not ready'}
                    onClick={handleExport}
                  >
                    <Download className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function HeroViewer(): React.JSX.Element {
  const heroFiles = useMemo(() => ({ [heroMainFile]: { content: encodeTextFile(qrcodeScad) } }), []);

  return (
    <CadPreviewProvider buildId={heroBuildId} mainFile={heroMainFile} files={heroFiles}>
      <HeroViewerInner />
    </CadPreviewProvider>
  );
}
