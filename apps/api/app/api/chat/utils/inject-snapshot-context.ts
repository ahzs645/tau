import type { UIMessage } from 'ai';
import type { ChatSnapshot } from '@taucad/chat';

/**
 * Injects editor context snapshot into the last user message's text content.
 * This prepends context blocks to help the AI understand:
 * - The current project's file structure
 * - Which file is currently active (being rendered by CAD)
 * - Which files are open in editor tabs
 *
 * @param messages - The array of UI messages to process
 * @param snapshot - The editor context snapshot to inject
 * @returns A new array of messages with the context injected
 */
export function injectSnapshotContext<T extends UIMessage>(messages: T[], snapshot: ChatSnapshot): T[] {
  // Find the last user message and prepend the context
  const lastUserMessageIndex = messages.findLastIndex((message) => message.role === 'user');

  if (lastUserMessageIndex === -1) {
    return messages;
  }

  const lastUserMessage = messages[lastUserMessageIndex];

  if (!lastUserMessage) {
    return messages;
  }

  // Build context string from snapshot components
  const contextParts: string[] = [];

  // Add active file context
  if (snapshot.activeFile) {
    contextParts.push(`<active_file>
The file currently being rendered by the CAD engine: ${snapshot.activeFile.path}
</active_file>`);
  }

  // Add open files context
  if (snapshot.openFiles && snapshot.openFiles.length > 0) {
    const fileList = snapshot.openFiles.map((file) => file.path).join(', ');
    contextParts.push(`<open_files>
Files currently open in the editor tabs: ${fileList}
</open_files>`);
  }

  // Add filesystem context
  if (snapshot.filesystem) {
    contextParts.push(`<project_layout>
Below is a snapshot of the current project's file structure:

${snapshot.filesystem}
</project_layout>`);
  }

  // If no context to add, return original messages
  if (contextParts.length === 0) {
    return messages;
  }

  // Wrap all context in editor_context tags
  const editorContext = `<editor_context>
${contextParts.join('\n\n')}
</editor_context>

`;

  // Create updated message with context prepended to text content
  const updatedParts = lastUserMessage.parts.map((part) => {
    if (part.type === 'text') {
      return { ...part, text: editorContext + part.text };
    }

    return part;
  });

  return [
    ...messages.slice(0, lastUserMessageIndex),
    { ...lastUserMessage, parts: updatedParts },
    ...messages.slice(lastUserMessageIndex + 1),
  ] as T[];
}

