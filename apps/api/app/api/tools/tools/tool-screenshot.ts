import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import type { ScreenshotOutput } from '@taucad/chat';
import { screenshotInputSchema } from '@taucad/chat';
import { assertRpcSuccess } from '@taucad/chat/utils';
import { rpcName, toolName } from '@taucad/chat/constants';
import type { ChatRpcConfigurable } from '#api/tools/tool.types.js';

export const screenshotToolDefinition = {
  name: toolName.screenshot,
  description: `Capture a screenshot of a specific compilation unit's 3D model for visual inspection.

You MUST pass \`targetFile\` (the source file path of the compilation unit to screenshot, e.g. "main.ts" or "lib/bracket.scad"). There is no implicit fallback — if no viewer panel currently displays \`targetFile\`, the call fails with UNKNOWN_COMPILATION_UNIT.

Modes:
- single: Captures the current camera perspective of the targetFile's viewer (1 image)
- multi_angle: Captures a labeled composite of all 6 orthographic views (front, back, right, left, top, bottom) of the targetFile as a single image`,
  schema: screenshotInputSchema,
} as const;

export const screenshotTool = tool(async (args, runtime: ToolRuntime): Promise<ScreenshotOutput> => {
  const { chatRpcService, thread_id: chatId } = runtime.configurable as ChatRpcConfigurable;
  const { toolCallId } = runtime;
  const { targetFile } = args;

  if (args.mode === 'multi_angle') {
    const result = await chatRpcService.sendRpcRequest({
      chatId,
      toolCallId,
      rpcName: rpcName.captureObservations,
      args: { targetFile },
    });

    assertRpcSuccess(result, {
      toolName: toolName.screenshot,
      toolCallId,
      clientErrorMessage: `Failed to capture multi-angle screenshots for ${targetFile}`,
    });

    return {
      images: result.observations.map((obs) => ({
        view: obs.side,
        dataUrl: obs.src,
      })),
    };
  }

  // Single screenshot mode
  const result = await chatRpcService.sendRpcRequest({
    chatId,
    toolCallId,
    rpcName: rpcName.captureScreenshot,
    args: { targetFile },
  });

  assertRpcSuccess(result, {
    toolName: toolName.screenshot,
    toolCallId,
    clientErrorMessage: `Failed to capture screenshot for ${targetFile}`,
  });

  return {
    images: result.images.map((img) => ({
      view: img.view,
      dataUrl: img.dataUrl,
    })),
  };
}, screenshotToolDefinition);
