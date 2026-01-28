import { StructuredTool } from '@langchain/core/tools';
import { reasoningInputSchema } from '@taucad/chat';
import type { ReasoningInput, ReasoningOutput } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';

/**
 * Reasoning tool that allows the LLM to think through complex problems step-by-step.
 *
 * The LLM's thinking is captured in the input and displayed to the user.
 *
 * Note: Returns a string to avoid LangChain's stringification of plain objects.
 * LangChain's _formatToolOutput passes strings through as-is, but JSON.stringify's plain objects.
 */
class ReasoningTool extends StructuredTool {
  public override name = toolName.reasoning;

  public override description = `Think through complex problems step-by-step before acting.

Use for Feature Tree planning, analyzing requirements, or deciding between approaches.
Thinking is displayed to user in collapsible section.`;

  public override schema = reasoningInputSchema;

  protected override async _call(_input: ReasoningInput): Promise<ReasoningOutput> {
    // Reasoning tool is purely for display - the LLM's thinking is captured in the input
    // Return a string to avoid LangChain stringification (strings are passed through as-is)
    return 'success';
  }
}

export const reasoningTool = new ReasoningTool();
