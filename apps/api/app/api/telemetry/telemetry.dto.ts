import { createZodDto } from 'nestjs-zod';
import { ingestPayloadSchema } from '@taucad/telemetry';

export class IngestPayloadDto extends createZodDto(ingestPayloadSchema) {}
