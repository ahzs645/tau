import type { PartialDeep } from 'type-fest';
import type { Project } from '@taucad/types';

export type StorageProvider = {
  // Project operations
  createProject(project: Project): Promise<Project>;
  updateProject(
    projectId: string,
    update: PartialDeep<Project>,
    options: { ignoreKeys?: string[] },
  ): Promise<Project | undefined>;
  getProjects(): Promise<Project[]>;
  getProject(projectId: string): Promise<Project | undefined>;
};
