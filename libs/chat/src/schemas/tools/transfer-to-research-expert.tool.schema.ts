import type { z } from 'zod';
import { transferToolInputSchema, transferToolOutputSchema } from '#schemas/tools/transfer-tool.schema.js';

/** @public */
export const transferToResearchExpertInputSchema = transferToolInputSchema;
/** @public */
export const transferToResearchExpertOutputSchema = transferToolOutputSchema;

/** @public */
export type TransferToResearchExpertInput = z.infer<typeof transferToResearchExpertInputSchema>;
/** @public */
export type TransferToResearchExpertOutput = z.infer<typeof transferToResearchExpertOutputSchema>;
