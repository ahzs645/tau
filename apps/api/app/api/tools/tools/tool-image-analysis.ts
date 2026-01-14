import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { imageAnalysisInputSchema } from '@taucad/chat';
import type { ImageAnalysisOutput, CaptureObservationsOutput } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import type { ChatToolsConfigurable } from '#api/tools/tool.types.js';

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

export const imageAnalysisTool = tool(async (input, runtime: ToolRuntime) => {
  const args = input as { requirements: string[] };
  const { chatToolsService, analysisService, thread_id: chatId } = runtime.configurable as ChatToolsConfigurable;
  const { toolCallId } = runtime;
  const { requirements } = args;

  // Step 1: Capture observations from the frontend via WebSocket
  const captureResult = (await chatToolsService.sendToolCallRequest(
    chatId,
    toolCallId,
    toolName.captureObservations,
    {},
  )) as CaptureObservationsOutput;

  const { observations } = captureResult;

  // Step 2: Analyze the observations using AnalysisService
  const analysisResult = await analysisService.analyzeObservations(observations, requirements);

  // Step 3: Return the combined result
  const result: ImageAnalysisOutput = {
    observations,
    observationResults: analysisResult.observationResults,
    aggregatedResults: analysisResult.aggregatedResults,
    evaluationCriteria: analysisResult.evaluationCriteria,
  };

  return result;
}, imageAnalysisToolDefinition);
