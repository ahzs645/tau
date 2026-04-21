import { useRouteLoaderData } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import type { Model, ModelFamily, ModelProvider } from '@taucad/chat';
import { ENV } from '#environment.config.js';
import type { loader } from '#root.js';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';
import { defaultChatModel } from '#constants/chat.constants.js';
import { unknownIconId } from '#components/icons/svg-icon.js';

/**
 * UI-local resolved view of a {@link Model}. Always non-null so call sites can
 * render display values without `??` fallbacks. When the API hasn't returned
 * the model yet (or never will), `family` and `provider.id` degrade to the
 * `'unknown'` sentinel that {@link SvgIcon} skips.
 */
export type ResolvedModel = {
  id: string;
  name: string;
  family: ModelFamily | typeof unknownIconId;
  provider: { id: ModelProvider | typeof unknownIconId; name: string };
  isResolved: boolean;
  model?: Model;
};

const buildResolved = (id: string, model?: Model): ResolvedModel => ({
  id,
  name: model?.name ?? id.split('/').pop() ?? id,
  family: model?.details.family ?? unknownIconId,
  provider: model?.provider ?? { id: unknownIconId, name: 'Unknown' },
  isResolved: Boolean(model),
  model,
});

export const getModels = async (): Promise<Model[]> => {
  try {
    const response = await fetch(`${ENV.TAU_API_URL}/v1/models`, {
      credentials: 'include',
    });
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- TODO: replace with SDK fetcher
    const data = await response.json();

    // oxlint-disable-next-line @typescript-eslint/no-unsafe-return -- TODO: replace with SDK fetcher
    return data;
  } catch {
    return [];
  }
};

// oxlint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- intentionally allowing inference
export const useModels = () => {
  const loaderData = useRouteLoaderData<typeof loader>('root');
  const [selectedModelId, setSelectedModelId] = useCookie(cookieName.chatModel, defaultChatModel);

  const { data, isLoading } = useQuery({
    queryKey: ['models'],
    queryFn: async () => getModels(),
    refetchInterval: 1000 * 60 * 5, // 5 minutes
    initialData: loaderData?.models,
  });

  const modelById = useMemo(() => new Map((data ?? []).map((m) => [m.id, m])), [data]);

  const resolveModel = useCallback((id: string): ResolvedModel => buildResolved(id, modelById.get(id)), [modelById]);

  const selectedModel = useMemo<ResolvedModel>(
    () => buildResolved(selectedModelId, modelById.get(selectedModelId)),
    [modelById, selectedModelId],
  );

  return {
    data,
    isLoading,
    selectedModel,
    selectedModelId,
    setSelectedModelId,
    resolveModel,
  };
};
