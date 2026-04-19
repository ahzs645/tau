import type { modelFamilies, modelProviders } from '#constants/model.constants.js';

/** @public */
export type ModelProvider = (typeof modelProviders)[number];

/** @public */
export type ModelFamily = (typeof modelFamilies)[number];

/** @public */
export type Model = {
  id: string;
  model: string;
  name: string;
  slug: string;
  description?: string;
  provider: {
    id: ModelProvider;
    name: string;
  };
  contextLength?: number;
  details: {
    family: ModelFamily;
    parameterSize?: string;
    contextWindow?: number;
    cost?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };
  };
};
