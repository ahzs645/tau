import { useEffect, useMemo, useState, useRef } from 'react';
import { useSelector } from '@xstate/react';
import { fromPromise } from 'xstate';
import type { Build } from '@taucad/types';
import { Box } from 'lucide-react';
import { CadViewer } from '#components/geometry/cad/cad-viewer.js';
import { BuildProvider, useBuild } from '#hooks/use-build.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { Loader } from '#components/ui/loader.js';

type Files = Map<string, { filename: string; content: Uint8Array<ArrayBuffer> }>;

type ImportViewerProperties = {
  readonly files: Files;
  readonly mainFile: string | undefined;
  readonly owner: string;
  readonly repo: string;
};

type ImportBuild = Build & { files: Record<string, { content: Uint8Array<ArrayBuffer> }> };

function createImportBuild(files: Files, mainFile: string, owner: string, repo: string): ImportBuild {
  const buildFiles: Record<string, { content: Uint8Array<ArrayBuffer> }> = {};
  for (const [path, file] of files) {
    buildFiles[path] = { content: file.content };
  }

  return {
    id: `import-preview-${owner}-${repo}`,
    assets: {
      mechanical: {
        main: mainFile,
        parameters: {},
      },
    },
    name: `${owner}/${repo}`,
    description: `Preview of ${owner}/${repo}`,
    author: {
      name: 'Preview',
      avatar: '/avatar-sample.png',
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tags: [],
    thumbnail: '',
    files: buildFiles,
  };
}

type ImportViewerContentProperties = {
  readonly files: Record<string, { content: Uint8Array<ArrayBuffer> }>;
  readonly buildId: string;
};

function ImportViewerContent({ files, buildId }: ImportViewerContentProperties): React.JSX.Element {
  const { cadRef, buildRef } = useBuild();
  const { writeFiles } = useFileManager();

  const [hasLoadedModel, setHasLoadedModel] = useState(false);
  const hasWrittenFilesRef = useRef(false);

  const geometries = useSelector(cadRef, (snapshot) => snapshot.context.geometries);
  const cadStatus = useSelector(cadRef, (snapshot) => snapshot.value);

  // Write files and load model
  useEffect(() => {
    async function initializeAndLoadModel(): Promise<void> {
      if (!hasWrittenFilesRef.current) {
        const buildFiles: Record<string, { content: Uint8Array<ArrayBuffer> }> = {};
        for (const [path, file] of Object.entries(files)) {
          buildFiles[`/builds/${buildId}/${path}`] = file;
        }

        await writeFiles(buildFiles);
        hasWrittenFilesRef.current = true;
      }

      if (!hasLoadedModel) {
        buildRef.send({ type: 'loadModel' });
        setHasLoadedModel(true);
      }
    }

    void initializeAndLoadModel();
  }, [files, writeFiles, buildRef, hasLoadedModel, buildId]);

  const isLoading = ['initializing', 'booting', 'buffering', 'rendering'].includes(cadStatus);

  if (isLoading) {
    return (
      <div className="flex size-full items-center justify-center">
        <Loader className="size-12" />
      </div>
    );
  }

  if (geometries.length > 0) {
    return (
      <CadViewer
        geometries={geometries}
        className="size-full"
        stageOptions={{
          zoomLevel: 1.5,
        }}
      />
    );
  }

  return (
    <div className="flex size-full items-center justify-center">
      <Loader className="size-12" />
    </div>
  );
}

export function ImportViewer({ files, mainFile, owner, repo }: ImportViewerProperties): React.JSX.Element {
  // Create build data when we have a main file
  const importBuild = useMemo(() => {
    if (!mainFile || files.size === 0) {
      return undefined;
    }

    return createImportBuild(files, mainFile, owner, repo);
  }, [files, mainFile, owner, repo]);

  // Show placeholder when no file is selected
  if (!mainFile || !importBuild) {
    return (
      <div className="flex size-full items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Box className="size-12 opacity-30" strokeWidth={1} />
          <span className="text-sm">Select a file to preview</span>
        </div>
      </div>
    );
  }

  return (
    <BuildProvider
      key={`${importBuild.id}-${mainFile}`}
      buildId={importBuild.id}
      input={{ shouldLoadModelOnStart: false }}
      provide={{
        actors: {
          loadBuildActor: fromPromise(async () => {
            const { files: _, ...rest } = importBuild;
            return rest;
          }),
        },
      }}
    >
      <ImportViewerContent files={importBuild.files} buildId={importBuild.id} />
    </BuildProvider>
  );
}
