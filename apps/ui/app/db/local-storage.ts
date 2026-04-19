import type { PartialDeep } from 'type-fest';
import deepmerge from 'deepmerge/index.js';
import type { Project } from '@taucad/types';
import { idPrefix } from '@taucad/types/constants';
import { generatePrefixedId } from '@taucad/utils/id';
import type { StorageProvider } from '#types/storage.types.js';
import { metaConfig } from '#constants/meta.constants.js';

export class LocalStorageProvider implements StorageProvider {
  private readonly projectsKey = `${metaConfig.databasePrefix}projects`;

  public async createProject(project: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>): Promise<Project> {
    const id = generatePrefixedId(idPrefix.project);
    const timestamp = Date.now();
    const projectWithId = {
      ...project,
      id,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const projects = this.getProjectsInternal();
    projects.push(projectWithId);
    this.saveProjects(projects);
    return projectWithId;
  }

  public async updateProject(
    projectId: string,
    update: PartialDeep<Project>,
    options?: {
      /**
       * Keys to ignore when merging the project
       */
      ignoreKeys?: string[];
    },
  ): Promise<Project | undefined> {
    const projects = this.getProjectsInternal();
    const index = projects.findIndex((project) => project.id === projectId);

    if (index === -1) {
      return undefined;
    }

    // If update contains an 'id' field matching projectId, treat it as a full project replacement
    // This is the new pattern from the parallel state machine refactor
    const isProject = 'id' in update && update.id === projectId;

    let updatedProject: Project;

    if (isProject) {
      // Full project replacement - no merging needed
      updatedProject = update as Project;
    } else {
      // Partial update - use deepmerge for backward compatibility
      const mergeIgnoreKeys = new Set(options?.ignoreKeys ?? []);

      updatedProject = deepmerge(
        projects[index]!,
        { ...update, updatedAt: Date.now() },
        {
          customMerge(key) {
            if (mergeIgnoreKeys.has(key)) {
              return (_source: unknown, target: unknown) => target;
            }

            return undefined;
          },
        },
      ) as Project;
    }

    projects[index] = updatedProject;
    this.saveProjects(projects);
    return updatedProject;
  }

  public async getProjects(): Promise<Project[]> {
    return this.getProjectsInternal();
  }

  public async getProject(projectId: string): Promise<Project | undefined> {
    const projects = this.getProjectsInternal();
    return projects.find((b) => b.id === projectId);
  }

  public async deleteProject(projectId: string): Promise<void> {
    const projects = this.getProjectsInternal();
    const index = projects.findIndex((b) => b.id === projectId);
    if (index !== -1) {
      projects.splice(index, 1);
      this.saveProjects(projects);
    }
  }

  private getProjectsInternal(): Project[] {
    const data = localStorage.getItem(this.projectsKey);
    return data ? (JSON.parse(data) as Project[]) : [];
  }

  private saveProjects(projects: Project[]): void {
    localStorage.setItem(this.projectsKey, JSON.stringify(projects));
  }
}
