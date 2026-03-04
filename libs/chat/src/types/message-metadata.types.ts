// oxlint-disable-next-line eslint-plugin-import/no-named-as-default -- standard zod default import
import type z from 'zod';
import type { messageMetadataSchema, snapshotSchema } from '#schemas/metadata.schema.js';

export type MyMetadata = z.infer<typeof messageMetadataSchema>;

/**
 * Snapshot of the user's editor context at message submission time.
 * Provides the LLM with awareness of what the user is currently working on.
 */
export type ChatSnapshot = z.infer<typeof snapshotSchema>;
