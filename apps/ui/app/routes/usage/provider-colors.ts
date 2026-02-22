import { stringToColor } from '#utils/color.utils.js';

/**
 * Get a consistent color for a provider name using the stringToColor hash function.
 * This ensures the same provider always gets the same color across all charts and badges.
 */
export function getProviderColor(provider: string): string {
  return stringToColor(provider, 0.5);
}

/**
 * Get a consistent color for a model name using the stringToColor hash function.
 * This ensures the same model always gets the same color across all charts.
 */
export function getModelColor(modelName: string): string {
  return stringToColor(modelName, 0.5);
}
