import type { z } from 'zod';
import { transferToolInputSchema, transferToolOutputSchema } from '#schemas/tools/transfer-tool.schema.js';

/** @public */
export const transferToCadExpertInputSchema = transferToolInputSchema;
/** @public */
export const transferToCadExpertOutputSchema = transferToolOutputSchema;

/** @public */
export type TransferToCadExpertInput = z.infer<typeof transferToCadExpertInputSchema>;
/** @public */
export type TransferToCadExpertOutput = z.infer<typeof transferToCadExpertOutputSchema>;
