import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { observationSchema } from '@taucad/chat';

export const analyzeObservationsSchema = z
  .object({
    observations: z.array(observationSchema),
    requirements: z.array(z.string()),
  })
  .meta({ id: 'AnalyzeObservations' });

export class AnalyzeObservationsDto extends createZodDto(analyzeObservationsSchema) {}
