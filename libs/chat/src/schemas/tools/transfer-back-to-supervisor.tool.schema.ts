import type { z } from 'zod';
import { transferToolInputSchema, transferToolOutputSchema } from '#schemas/tools/transfer-tool.schema.js';

/** @public */
export const transferBackToSupervisorInputSchema = transferToolInputSchema;
/** @public */
export const transferBackToSupervisorOutputSchema = transferToolOutputSchema;

/** @public */
export type TransferBackToSupervisorInput = z.infer<typeof transferBackToSupervisorInputSchema>;
/** @public */
export type TransferBackToSupervisorOutput = z.infer<typeof transferBackToSupervisorOutputSchema>;
