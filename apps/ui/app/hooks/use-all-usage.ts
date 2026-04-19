import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { Project } from '@taucad/types';
import type { Chat } from '@taucad/chat';
import { useProjectManager } from '#hooks/use-project-manager.js';
import { useModels } from '#hooks/use-models.js';

/**
 * Represents a single usage record extracted from a chat message.
 */
export type UsageRecord = {
  id: string;
  date: Date;
  model: string;
  modelName: string;
  provider: string;
  projectId: string;
  projectName: string;
  chatId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  inputTokensCost: number;
  outputTokensCost: number;
  cacheReadTokensCost: number;
  cacheWriteTokensCost: number;
  totalCost: number;
};

type ProjectsWithChats = {
  project: Project;
  chats: Chat[];
};

/**
 * Hook to aggregate all usage data across all projects and chats.
 * Extracts usage records from data-usage message parts and enriches them
 * with model display names and provider information.
 */
export function useAllUsage(): {
  records: UsageRecord[];
  isLoading: boolean;
  error: Error | undefined;
  refetch: () => void;
} {
  const { getProjects, getChatsForResource, isLoading: isProjectManagerLoading } = useProjectManager();
  const { data: models } = useModels();

  // Create a map for quick model lookup
  const modelMap = useMemo(() => {
    const map = new Map<string, { name: string; provider: string }>();
    if (models) {
      for (const model of models) {
        map.set(model.id, {
          name: model.name,
          provider: model.provider.name,
        });
      }
    }

    return map;
  }, [models]);

  // Fetch all projects and their chats in a single query
  const {
    data: projectsWithChats = [],
    isLoading: isDataLoading,
    error: queryError,
    refetch,
  } = useQuery({
    queryKey: ['all-usage-data'],
    async queryFn(): Promise<ProjectsWithChats[]> {
      const projects = await getProjects({ includeDeleted: false });
      const results: ProjectsWithChats[] = [];

      // Fetch chats for all projects in parallel
      const chatsPromises = projects.map(async (project) => {
        const chats = await getChatsForResource(project.id, { includeDeleted: false });
        return { project, chats };
      });

      const settledResults = await Promise.all(chatsPromises);
      results.push(...settledResults);

      return results;
    },
    enabled: !isProjectManagerLoading,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  // Extract and normalize usage records from all chats
  const records = useMemo((): UsageRecord[] => {
    if (projectsWithChats.length === 0) {
      return [];
    }

    const usageRecords: UsageRecord[] = [];

    for (const { project, chats } of projectsWithChats) {
      for (const chat of chats) {
        // Extract usage parts from all messages in this chat
        const usageParts = chat.messages.flatMap((message) =>
          message.parts.filter((part) => part.type === 'data-usage'),
        );

        for (const part of usageParts) {
          // Type is already narrowed by the filter above
          const { data } = part;
          const modelInfo = modelMap.get(data.model);

          usageRecords.push({
            id: data.id,
            // Use chat's updatedAt as the timestamp (more accurate for when usage occurred)
            date: new Date(chat.updatedAt),
            model: data.model,
            modelName: modelInfo?.name ?? data.model,
            provider: modelInfo?.provider ?? 'Unknown',
            projectId: project.id,
            projectName: project.name,
            chatId: chat.id,
            inputTokens: data.inputTokens,
            outputTokens: data.outputTokens,
            cacheReadTokens: data.cacheReadTokens,
            cacheWriteTokens: data.cacheWriteTokens,
            totalTokens: data.inputTokens + data.outputTokens + data.cacheReadTokens + data.cacheWriteTokens,
            inputTokensCost: data.inputTokensCost,
            outputTokensCost: data.outputTokensCost,
            cacheReadTokensCost: data.cacheReadTokensCost,
            cacheWriteTokensCost: data.cacheWriteTokensCost,
            totalCost: data.totalCost,
          });
        }
      }
    }

    // Sort by date descending (most recent first)
    usageRecords.sort((a, b) => b.date.getTime() - a.date.getTime());

    return usageRecords;
  }, [projectsWithChats, modelMap]);

  const handleRefetch = (): void => {
    void refetch();
  };

  const isLoading = isProjectManagerLoading || isDataLoading;

  return {
    records,
    isLoading,
    error: queryError instanceof Error ? queryError : undefined,
    refetch: handleRefetch,
  };
}
