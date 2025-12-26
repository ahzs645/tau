import { z } from 'zod';

/**
 * Schema for privacy preferences
 */
export const privacyPreferencesSchema = z.object({
  allowsAiTraining: z
    .boolean()
    .describe('Whether the user allows their AI prompts and designs to be used for AI service improvement'),
});

/**
 * Schema for updating privacy preferences (all fields optional)
 */
export const updatePrivacyPreferencesSchema = z
  .object({
    allowsAiTraining: z
      .boolean()
      .optional()
      .describe('Whether the user allows their AI prompts and designs to be used for AI service improvement'),
  })
  .meta({ id: 'UpdatePrivacyPreferences' });

/**
 * Privacy preferences type
 */
export type PrivacyPreferences = z.infer<typeof privacyPreferencesSchema>;

/**
 * Update privacy preferences input type
 */
export type UpdatePrivacyPreferencesInput = z.infer<typeof updatePrivacyPreferencesSchema>;
