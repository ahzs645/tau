import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import type { ChatSnapshot } from '@taucad/chat';
import { injectSnapshotContext } from '#api/chat/utils/inject-snapshot-context.js';

function createUserMessage(text: string, id = 'msg-1'): UIMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

function createAssistantMessage(text: string, id = 'msg-2'): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', text }],
  };
}

describe('injectSnapshotContext', () => {
  const fileTree: ChatSnapshot['fileTree'] = [
    { path: 'src', name: 'src', type: 'dir', size: 0 },
    { path: 'src/index.ts', name: 'index.ts', type: 'file', size: 1024 },
    { path: 'src/utils', name: 'utils', type: 'dir', size: 0 },
    { path: 'src/utils/helper.ts', name: 'helper.ts', type: 'file', size: 512 },
  ];

  const fullSnapshot: ChatSnapshot = {
    fileTree,
    activeFile: { path: 'src/index.ts', name: 'index.ts' },
    openFiles: [
      { path: 'src/index.ts', name: 'index.ts' },
      { path: 'src/utils/helper.ts', name: 'helper.ts' },
    ],
  };

  describe('with full snapshot', () => {
    it('should inject all context types into last user message', () => {
      const messages = [createUserMessage('Help me with my code')];

      const result = injectSnapshotContext(messages, fullSnapshot);

      expect(result).toHaveLength(1);
      const { text } = result[0]?.parts[0] as { type: 'text'; text: string };

      // Should have editor_context wrapper
      expect(text).toContain('<editor_context>');
      expect(text).toContain('</editor_context>');

      // Should have active file
      expect(text).toContain('<active_file>');
      expect(text).toContain('src/index.ts');
      expect(text).toContain('</active_file>');

      // Should have open files
      expect(text).toContain('<open_files>');
      expect(text).toContain('src/index.ts, src/utils/helper.ts');
      expect(text).toContain('</open_files>');

      // Should have project layout with generated tree
      expect(text).toContain('<project_layout>');
      expect(text).toContain('/project/');
      expect(text).toContain('src/');
      expect(text).toContain('index.ts');
      expect(text).toContain('helper.ts');
      expect(text).toContain('</project_layout>');

      // Should preserve original message
      expect(text).toContain('Help me with my code');
    });

    it('should format context in correct order: activeFile, openFiles, fileTree', () => {
      const messages = [createUserMessage('Test')];

      const result = injectSnapshotContext(messages, fullSnapshot);
      const { text } = result[0]?.parts[0] as { type: 'text'; text: string };

      const activeFileIndex = text.indexOf('<active_file>');
      const openFilesIndex = text.indexOf('<open_files>');
      const projectLayoutIndex = text.indexOf('<project_layout>');

      expect(activeFileIndex).toBeLessThan(openFilesIndex);
      expect(openFilesIndex).toBeLessThan(projectLayoutIndex);
    });
  });

  describe('with partial snapshot', () => {
    it('should inject only fileTree when only fileTree is provided', () => {
      const snapshot: ChatSnapshot = { fileTree };
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, snapshot);
      const { text } = result[0]?.parts[0] as { type: 'text'; text: string };

      expect(text).toContain('<project_layout>');
      expect(text).not.toContain('<active_file>');
      expect(text).not.toContain('<open_files>');
    });

    it('should inject only activeFile when only activeFile is provided', () => {
      const snapshot: ChatSnapshot = {
        activeFile: { path: 'main.scad', name: 'main.scad' },
      };
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, snapshot);
      const { text } = result[0]?.parts[0] as { type: 'text'; text: string };

      expect(text).toContain('<active_file>');
      expect(text).toContain('main.scad');
      expect(text).not.toContain('<project_layout>');
      expect(text).not.toContain('<open_files>');
    });

    it('should inject only openFiles when only openFiles is provided', () => {
      const snapshot: ChatSnapshot = {
        openFiles: [
          { path: 'file1.scad', name: 'file1.scad' },
          { path: 'file2.scad', name: 'file2.scad' },
        ],
      };
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, snapshot);
      const { text } = result[0]?.parts[0] as { type: 'text'; text: string };

      expect(text).toContain('<open_files>');
      expect(text).toContain('file1.scad, file2.scad');
      expect(text).not.toContain('<project_layout>');
      expect(text).not.toContain('<active_file>');
    });

    it('should skip openFiles section when openFiles array is empty', () => {
      const snapshot: ChatSnapshot = {
        fileTree,
        openFiles: [],
      };
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, snapshot);
      const { text } = result[0]?.parts[0] as { type: 'text'; text: string };

      expect(text).toContain('<project_layout>');
      expect(text).not.toContain('<open_files>');
    });

    it('should skip fileTree section when fileTree array is empty', () => {
      const snapshot: ChatSnapshot = {
        fileTree: [],
        activeFile: { path: 'main.scad', name: 'main.scad' },
      };
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, snapshot);
      const { text } = result[0]?.parts[0] as { type: 'text'; text: string };

      expect(text).toContain('<active_file>');
      expect(text).not.toContain('<project_layout>');
    });
  });

  describe('with empty snapshot', () => {
    it('should return original messages when snapshot is empty', () => {
      const snapshot: ChatSnapshot = {};
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, snapshot);

      expect(result).toEqual(messages);
    });
  });

  describe('message handling', () => {
    it('should return original messages if no user message exists', () => {
      const messages = [createAssistantMessage('Hello!')];

      const result = injectSnapshotContext(messages, fullSnapshot);

      expect(result).toEqual(messages);
    });

    it('should inject into the last user message when multiple exist', () => {
      const messages = [
        createUserMessage('First question', 'msg-1'),
        createAssistantMessage('First answer', 'msg-2'),
        createUserMessage('Second question', 'msg-3'),
      ];

      const result = injectSnapshotContext(messages, fullSnapshot);

      expect(result).toHaveLength(3);
      // First message should be unchanged
      expect((result[0]?.parts[0] as { type: 'text'; text: string }).text).toBe('First question');
      // Last user message should have context
      expect((result[2]?.parts[0] as { type: 'text'; text: string }).text).toContain('<editor_context>');
      expect((result[2]?.parts[0] as { type: 'text'; text: string }).text).toContain('Second question');
    });

    it('should return empty array for empty messages array', () => {
      const messages: UIMessage[] = [];

      const result = injectSnapshotContext(messages, fullSnapshot);

      expect(result).toEqual([]);
    });

    it('should preserve non-text parts in the message', () => {
      const messageWithImage: UIMessage = {
        id: 'msg-1',
        role: 'user',
        parts: [
          { type: 'text', text: 'Check this image' },
          {
            type: 'file',
            mediaType: 'image/png',
            url: 'https://example.com/image.png',
          },
        ],
      };
      const messages = [messageWithImage];

      const result = injectSnapshotContext(messages, fullSnapshot);

      expect(result[0]?.parts).toHaveLength(2);
      expect(result[0]?.parts[0]).toHaveProperty('type', 'text');
      expect((result[0]?.parts[0] as { type: 'text'; text: string }).text).toContain('<editor_context>');
      expect(result[0]?.parts[1]).toHaveProperty('type', 'file');
    });

    it('should prepend context to each text part', () => {
      const messageWithMultipleTextParts: UIMessage = {
        id: 'msg-1',
        role: 'user',
        parts: [
          { type: 'text', text: 'Part one' },
          { type: 'text', text: 'Part two' },
        ],
      };
      const messages = [messageWithMultipleTextParts];

      const result = injectSnapshotContext(messages, fullSnapshot);

      // Each text part gets the context prepended
      expect((result[0]?.parts[0] as { type: 'text'; text: string }).text).toContain('<editor_context>');
      expect((result[0]?.parts[0] as { type: 'text'; text: string }).text).toContain('Part one');
      expect((result[0]?.parts[1] as { type: 'text'; text: string }).text).toContain('<editor_context>');
      expect((result[0]?.parts[1] as { type: 'text'; text: string }).text).toContain('Part two');
    });

    it('should not mutate original messages array', () => {
      const originalMessage = createUserMessage('Original text');
      const messages = [originalMessage];

      const result = injectSnapshotContext(messages, fullSnapshot);

      expect(result).not.toBe(messages);
      expect(result[0]).not.toBe(originalMessage);
      expect((originalMessage.parts[0] as { type: 'text'; text: string }).text).toBe('Original text');
    });
  });

  describe('context formatting', () => {
    it('should format active file context correctly', () => {
      const snapshot: ChatSnapshot = {
        activeFile: { path: 'lib/shapes.scad', name: 'shapes.scad' },
      };
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, snapshot);
      const { text } = result[0]?.parts[0] as { type: 'text'; text: string };

      expect(text).toContain('The file currently being rendered by the CAD engine: lib/shapes.scad');
    });

    it('should format open files as comma-separated list', () => {
      const snapshot: ChatSnapshot = {
        openFiles: [
          { path: 'a.scad', name: 'a.scad' },
          { path: 'b.scad', name: 'b.scad' },
          { path: 'c.scad', name: 'c.scad' },
        ],
      };
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, snapshot);
      const { text } = result[0]?.parts[0] as { type: 'text'; text: string };

      expect(text).toContain('Files currently open in the editor tabs: a.scad, b.scad, c.scad');
    });

    it('should wrap all context in editor_context tags', () => {
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, fullSnapshot);
      const { text } = result[0]?.parts[0] as { type: 'text'; text: string };

      expect(text).toMatch(/^<editor_context>\n/);
      expect(text).toContain('</editor_context>\n\nHello');
    });

    it('should end context with double newline before user message', () => {
      const messages = [createUserMessage('My question')];

      const result = injectSnapshotContext(messages, fullSnapshot);
      const { text } = result[0]?.parts[0] as { type: 'text'; text: string };

      expect(text).toMatch(/<\/editor_context>\n\nMy question$/);
    });

    it('should generate tree structure from fileTree entries', () => {
      const snapshot: ChatSnapshot = {
        fileTree: [
          { path: 'lib', name: 'lib', type: 'dir', size: 0 },
          { path: 'lib/shapes.scad', name: 'shapes.scad', type: 'file', size: 2048 },
          { path: 'lib/utils.scad', name: 'utils.scad', type: 'file', size: 1024 },
          { path: 'main.scad', name: 'main.scad', type: 'file', size: 5120 },
        ],
      };
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, snapshot);
      const { text } = result[0]?.parts[0] as { type: 'text'; text: string };

      // Should have project root
      expect(text).toContain('/project/');
      // Should have directory with trailing slash
      expect(text).toContain('lib/');
      // Should have files with sizes
      expect(text).toContain('shapes.scad (2KB)');
      expect(text).toContain('utils.scad (1KB)');
      expect(text).toContain('main.scad (5KB)');
    });

    it('should sort directories before files in tree output', () => {
      const snapshot: ChatSnapshot = {
        fileTree: [
          { path: 'main.scad', name: 'main.scad', type: 'file', size: 100 },
          { path: 'lib', name: 'lib', type: 'dir', size: 0 },
          { path: 'lib/utils.scad', name: 'utils.scad', type: 'file', size: 100 },
        ],
      };
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, snapshot);
      const { text } = result[0]?.parts[0] as { type: 'text'; text: string };

      const libIndex = text.indexOf('lib/');
      const mainIndex = text.indexOf('main.scad');

      // Directory should come before file
      expect(libIndex).toBeLessThan(mainIndex);
    });

    it('should show empty message for empty fileTree', () => {
      const snapshot: ChatSnapshot = {
        fileTree: [],
        activeFile: { path: 'test.scad', name: 'test.scad' },
      };
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, snapshot);
      const { text } = result[0]?.parts[0] as { type: 'text'; text: string };

      // Should not have project_layout for empty tree
      expect(text).not.toContain('<project_layout>');
      // Should still have active file
      expect(text).toContain('<active_file>');
    });
  });
});
