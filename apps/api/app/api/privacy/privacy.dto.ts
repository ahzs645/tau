import { createZodDto } from 'nestjs-zod';
import { updatePrivacyPreferencesSchema } from '#api/privacy/privacy.schema.js';

export class UpdatePrivacyPreferencesDto extends createZodDto(updatePrivacyPreferencesSchema) {}
