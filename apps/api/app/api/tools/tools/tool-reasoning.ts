import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { interrupt } from '@langchain/langgraph';
import { reasoningInputSchema } from '@taucad/chat';
import type { ReasoningOutput } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';

const reasoningJsonSchema = z.toJSONSchema(reasoningInputSchema);

export const reasoningToolDefinition = {
  name: toolName.reasoning,
  description: `Think through complex problems step-by-step before acting.

Use for Feature Tree planning, analyzing requirements, or deciding between approaches.
Thinking is displayed to user in collapsible section.`,
  schema: reasoningJsonSchema,
} as const;

export const reasoningTool = tool((args) => {
  const result = interrupt<unknown, ReasoningOutput>(args);
  return result;
}, reasoningToolDefinition);
