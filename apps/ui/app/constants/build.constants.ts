import type { Build, File } from '@taucad/types';

export type CreateInitialBuildOptions = {
  buildName: string;
  mainFileName: string;
  emptyCodeContent: Uint8Array<ArrayBuffer>;
};

export type CreateInitialBuildResult = {
  buildData: Omit<Build, 'id' | 'createdAt' | 'updatedAt'>;
  files: Record<string, File>;
};

export function createInitialBuild(options: CreateInitialBuildOptions): CreateInitialBuildResult {
  const { buildName, mainFileName, emptyCodeContent } = options;

  const buildData: Omit<Build, 'id' | 'createdAt' | 'updatedAt'> = {
    name: buildName,
    description: '',
    author: {
      name: 'You',
      avatar: '/avatar-sample.png',
    },
    tags: [],
    thumbnail: '',
    assets: {
      mechanical: {
        main: mainFileName,
        parameters: {},
      },
    },
  };

  const files: Record<string, File> = {
    [mainFileName]: { content: emptyCodeContent },
  };

  return { buildData, files };
}
