import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { interrupt } from '@langchain/langgraph';
import { imageAnalysisInputSchema } from '@taucad/chat';
import type { ImageAnalysisOutput } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';

const imageAnalysisJsonSchema = z.toJSONSchema(imageAnalysisInputSchema);

export const imageAnalysisToolDefinition = {
  name: toolName.imageAnalysis,
  description: `Visually validate a CAD model against specific requirements.

Captures 6 individual orthographic view observations (FRONT, BACK, RIGHT, LEFT, TOP, BOTTOM), analyzes each in parallel against the provided requirements, and aggregates results.

Aggregation logic:
- FAILED: If ANY view definitively fails the requirement, OR if ALL views return indeterminate
- PASSED: If at least one view passes and no views fail
- Each view can return: passed, failed, or indeterminate (when visual information is insufficient)

Returns:
- observations: Array of captured images with id, side, and src
- observationResults: Per-observation analysis results matched by ID
- aggregatedResults: Combined results across all views
- evaluationCriteria: Analysis metadata`,
  schema: imageAnalysisJsonSchema,
} as const;

export const imageAnalysisTool = tool(async (args) => {
  const data = interrupt<unknown, ImageAnalysisOutput>(args);

  // Return the full output from the client (observations, observationResults, aggregatedResults, evaluationCriteria)
  return data;
}, imageAnalysisToolDefinition);
