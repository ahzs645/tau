import { tool } from '@langchain/core/tools';
import { z } from 'zod';
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

export const reasoningTool = tool(() => {
  // Reasoning tool is purely for display - the LLM's thinking is captured in the input
  return { acknowledged: true };
}, reasoningToolDefinition);

export const parseReasoningOutput = (content: string): ReasoningOutput => {
  return JSON.parse(content) as ReasoningOutput;
};
