import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  observationSchema,
  observationResultSchema,
  requirementResultSchema,
  evaluationCriteriaSchema,
} from '@taucad/chat';

// Request DTO
export const analyzeObservationsSchema = z
  .object({
    observations: z.array(observationSchema),
    requirements: z.array(z.string()),
  })
  .meta({ id: 'AnalyzeObservations' });

export class AnalyzeObservationsDto extends createZodDto(analyzeObservationsSchema) {}

// Response DTO
export const analyzeObservationsResponseSchema = z
  .object({
    observationResults: z.array(observationResultSchema),
    aggregatedResults: z.array(requirementResultSchema),
    evaluationCriteria: evaluationCriteriaSchema,
  })
  .meta({ id: 'AnalyzeObservationsResponse' });

export class AnalyzeObservationsResponseDto extends createZodDto(analyzeObservationsResponseSchema) {}
