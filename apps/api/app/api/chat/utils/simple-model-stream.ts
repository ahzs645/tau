import { JsonToSseTransformStream } from 'ai';
import type { StreamTextResult } from 'ai';
import type { FastifyReply } from 'fastify';

/**
 * Sends a simple model stream response using the Vercel AI SDK format.
 * This standardizes the streaming pattern used for simple model handlers
 * like name-generator and commit-name-generator.
 *
 * @param response - The Fastify reply object
 * @param streamResult - The result from streamText()
 * @returns A promise that resolves when the response is sent
 */
export async function sendSimpleModelStream(
  response: FastifyReply,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- StreamTextResult has complex generics that are not needed here
  streamResult: StreamTextResult<any, any>,
): Promise<void> {
  // Mark the response as a v1 data stream
  void response.header('content-type', 'text/event-stream');
  void response.header('x-vercel-ai-ui-message-stream', 'v1');
  void response.header('x-accel-buffering', 'no');

  const sseStream = streamResult.toUIMessageStream().pipeThrough(new JsonToSseTransformStream());

  return response.send(sseStream.pipeThrough(new TextEncoderStream()));
}
