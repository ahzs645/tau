import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { uiMessagesSchema } from '@taucad/chat';
import type { MyUIMessage } from '@taucad/chat';

export type CreateChat = {
  id: string;
  messages: MyUIMessage[];
};

export const createChatSchema: z.ZodType<CreateChat> = z
  .object({
    id: z.string(),
    messages: uiMessagesSchema,
  })
  .meta({ id: 'CreateChat' });

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- nestjs-zod pattern requires class extension
export class CreateChatDto extends createZodDto(createChatSchema) {}
