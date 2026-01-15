import type { ConstantRecord, ChatError } from '@taucad/types';
import type { messageRole, messageStatus } from '#constants/message.constants.js';
import type { MyUIMessage } from '#types/message.types.js';

export type MessageRole = ConstantRecord<typeof messageRole>;

export type MessageStatus = ConstantRecord<typeof messageStatus>;

export type MessagePart = MyUIMessage['parts'][number];

export type MessageAnnotation = {
  type: 'usage';
  usageTokens: ChatUsageTokens;
  usageCost: ChatUsageCost;
  model: string;
};

export type ChatUsageTokens = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ChatUsageCost = {
  inputTokensCost: number;
  outputTokensCost: number;
  cacheReadTokensCost: number;
  cacheWriteTokensCost: number;
  totalCost: number;
};

export type Chat = {
  id: string;
  resourceId: string; // Links chat to a resource (e.g., build)
  name: string;
  messages: MyUIMessage[];
  draft?: MyUIMessage; // Main draft
  messageEdits?: Record<string, MyUIMessage>; // Edit drafts by messageId
  error?: ChatError; // Persisted error for display after page reload
  createdAt: number;
  updatedAt: number;
  deletedAt?: number; // Soft delete support
};
