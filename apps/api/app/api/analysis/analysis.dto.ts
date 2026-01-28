import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { observationSchema, visualTestRequirementSchema, testModelOutputSchema } from '@taucad/chat';

// Request DTO for running visual tests
export const runVisualTestsSchema = z
  .object({
    observations: z.array(observationSchema).min(1, 'At least one observation is required'),
    requirements: z.array(visualTestRequirementSchema).min(1, 'At least one requirement is required'),
  })
  .meta({ id: 'RunVisualTests' });

export class RunVisualTestsDto extends createZodDto(runVisualTestsSchema) {}

// Response DTO for visual test results
export const runVisualTestsResponseSchema = testModelOutputSchema.meta({ id: 'RunVisualTestsResponse' });

export class RunVisualTestsResponseDto extends createZodDto(runVisualTestsResponseSchema) {}
