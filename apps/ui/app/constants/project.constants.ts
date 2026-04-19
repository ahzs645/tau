import type { Project, File } from '@taucad/types';

export type CreateInitialProjectOptions = {
  projectName: string;
  mainFileName: string;
  emptyCodeContent: Uint8Array<ArrayBuffer>;
};

export type CreateInitialProjectResult = {
  projectData: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>;
  files: Record<string, File>;
};

export function createInitialProject(options: CreateInitialProjectOptions): CreateInitialProjectResult {
  const { projectName, mainFileName, emptyCodeContent } = options;

  const projectData: Omit<Project, 'id' | 'createdAt' | 'updatedAt'> = {
    name: projectName,
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

  return { projectData, files };
}
