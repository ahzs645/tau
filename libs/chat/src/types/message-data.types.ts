// oxlint-disable-next-line eslint-plugin-import/no-named-as-default -- standard zod default import
import type z from 'zod';
import type { dataPartSchema } from '#schemas/message-data.schema.js';

export type MyDataPart = z.infer<typeof dataPartSchema>;
