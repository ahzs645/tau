import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '#database/database.service.js';
import { user } from '#database/schema.js';
import type { PrivacyPreferences, UpdatePrivacyPreferencesInput } from '#api/privacy/privacy.schema.js';
import { Span } from '#telemetry/tracer.service.js';

@Injectable()
export class PrivacyService {
  public constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Get privacy preferences for a user
   */
  @Span()
  public async getPrivacyPreferences(userId: string): Promise<PrivacyPreferences> {
    const result = await this.databaseService.database.query.user.findFirst({
      where: eq(user.id, userId),
      columns: {
        allowsAiTraining: true,
      },
    });

    return {
      allowsAiTraining: result?.allowsAiTraining ?? true,
    };
  }

  /**
   * Update privacy preferences for a user
   */
  @Span()
  public async updatePrivacyPreferences(
    userId: string,
    preferences: UpdatePrivacyPreferencesInput,
  ): Promise<PrivacyPreferences> {
    const [updated] = await this.databaseService.database
      .update(user)
      .set({
        allowsAiTraining: preferences.allowsAiTraining,
      })
      .where(eq(user.id, userId))
      .returning({
        allowsAiTraining: user.allowsAiTraining,
      });

    return {
      allowsAiTraining: updated?.allowsAiTraining ?? true,
    };
  }
}
