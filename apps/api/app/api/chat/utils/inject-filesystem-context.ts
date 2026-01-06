import type { UIMessage } from 'ai';

/**
 * Injects a filesystem snapshot into the last user message's text content.
 * This prepends a project layout context block to help the AI understand
 * the current project structure.
 *
 * @param messages - The array of UI messages to process
 * @param filesystemSnapshot - The filesystem snapshot string to inject
 * @returns A new array of messages with the filesystem context injected
 */
export function injectFilesystemContext<T extends UIMessage>(messages: T[], filesystemSnapshot: string): T[] {
  // Find the last user message and prepend the project layout
  const lastUserMessageIndex = messages.findLastIndex((message) => message.role === 'user');

  if (lastUserMessageIndex === -1) {
    return messages;
  }

  const lastUserMessage = messages[lastUserMessageIndex];

  if (!lastUserMessage) {
    return messages;
  }

  const projectLayoutContext = `<project_layout>
Below is a snapshot of the current project's file structure:

${filesystemSnapshot}
</project_layout>

`;

  // Create updated message with project layout prepended to text content
  const updatedParts = lastUserMessage.parts.map((part) => {
    if (part.type === 'text') {
      return { ...part, text: projectLayoutContext + part.text };
    }

    return part;
  });

  return [
    ...messages.slice(0, lastUserMessageIndex),
    { ...lastUserMessage, parts: updatedParts },
    ...messages.slice(lastUserMessageIndex + 1),
  ] as T[];
}
