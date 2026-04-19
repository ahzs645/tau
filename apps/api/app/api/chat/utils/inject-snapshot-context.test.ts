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
      // Context is prepended as first part
      expect(result[0]?.parts).toHaveLength(2);
      const contextPart = result[0]?.parts[0] as { type: 'text'; text: string };
      const originalPart = result[0]?.parts[1] as { type: 'text'; text: string };

      expect(contextPart.text).toContain('<system-reminder>');
      expect(contextPart.text).toContain('</system-reminder>');

      // Should have active file
      expect(contextPart.text).toContain('<active_file>');
      expect(contextPart.text).toContain('src/index.ts');
      expect(contextPart.text).toContain('</active_file>');

      // Should have open files
      expect(contextPart.text).toContain('<open_files>');
      expect(contextPart.text).toContain('src/index.ts, src/utils/helper.ts');
      expect(contextPart.text).toContain('</open_files>');

      // Should have project layout with generated tree
      expect(contextPart.text).toContain('<project_layout>');
      expect(contextPart.text).toContain('/project/');
      expect(contextPart.text).toContain('src/');
      expect(contextPart.text).toContain('index.ts');
      expect(contextPart.text).toContain('helper.ts');
      expect(contextPart.text).toContain('</project_layout>');

      // Should preserve original message in second part
      expect(originalPart.text).toBe('Help me with my code');
    });

    it('should format context in correct order: activeFile, openFiles, fileTree', () => {
      const messages = [createUserMessage('Test')];

      const result = injectSnapshotContext(messages, fullSnapshot);
      const contextPart = result[0]?.parts[0] as { type: 'text'; text: string };

      const activeFileIndex = contextPart.text.indexOf('<active_file>');
      const openFilesIndex = contextPart.text.indexOf('<open_files>');
      const projectLayoutIndex = contextPart.text.indexOf('<project_layout>');

      expect(activeFileIndex).toBeLessThan(openFilesIndex);
      expect(openFilesIndex).toBeLessThan(projectLayoutIndex);
    });
  });

  describe('with partial snapshot', () => {
    it('should inject only fileTree when only fileTree is provided', () => {
      const snapshot: ChatSnapshot = { fileTree };
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, snapshot);
      const contextPart = result[0]?.parts[0] as { type: 'text'; text: string };

      expect(contextPart.text).toContain('<project_layout>');
      expect(contextPart.text).not.toContain('<active_file>');
      expect(contextPart.text).not.toContain('<open_files>');
    });

    it('should inject only activeFile when only activeFile is provided', () => {
      const snapshot: ChatSnapshot = {
        activeFile: { path: 'main.scad', name: 'main.scad' },
      };
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, snapshot);
      const contextPart = result[0]?.parts[0] as { type: 'text'; text: string };

      expect(contextPart.text).toContain('<active_file>');
      expect(contextPart.text).toContain('main.scad');
      expect(contextPart.text).not.toContain('<project_layout>');
      expect(contextPart.text).not.toContain('<open_files>');
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
      const contextPart = result[0]?.parts[0] as { type: 'text'; text: string };

      expect(contextPart.text).toContain('<open_files>');
      expect(contextPart.text).toContain('file1.scad, file2.scad');
      expect(contextPart.text).not.toContain('<project_layout>');
      expect(contextPart.text).not.toContain('<active_file>');
    });

    it('should skip openFiles section when openFiles array is empty', () => {
      const snapshot: ChatSnapshot = {
        fileTree,
        openFiles: [],
      };
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, snapshot);
      const contextPart = result[0]?.parts[0] as { type: 'text'; text: string };

      expect(contextPart.text).toContain('<project_layout>');
      expect(contextPart.text).not.toContain('<open_files>');
    });

    it('should skip fileTree section when fileTree array is empty', () => {
      const snapshot: ChatSnapshot = {
        fileTree: [],
        activeFile: { path: 'main.scad', name: 'main.scad' },
      };
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, snapshot);
      const contextPart = result[0]?.parts[0] as { type: 'text'; text: string };

      expect(contextPart.text).toContain('<active_file>');
      expect(contextPart.text).not.toContain('<project_layout>');
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
      expect(result[0]?.parts).toHaveLength(1);
      // oxlint-disable-next-line no-unsafe-optional-chaining -- test assertion with preceding length check
      expect((result[0]?.parts[0] as { type: 'text'; text: string }).text).toBe('First question');
      // Last user message should have context prepended as first part
      expect(result[2]?.parts).toHaveLength(2);
      // oxlint-disable-next-line no-unsafe-optional-chaining -- test assertion with preceding length check
      expect((result[2]?.parts[0] as { type: 'text'; text: string }).text).toContain('<system-reminder>');
      // oxlint-disable-next-line no-unsafe-optional-chaining -- test assertion with preceding length check
      expect((result[2]?.parts[1] as { type: 'text'; text: string }).text).toBe('Second question');
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

      // Context prepended as first part, then original parts follow
      expect(result[0]?.parts).toHaveLength(3);
      expect(result[0]?.parts[0]).toHaveProperty('type', 'text');
      // oxlint-disable-next-line no-unsafe-optional-chaining -- test assertion with preceding length check
      expect((result[0]?.parts[0] as { type: 'text'; text: string }).text).toContain('<system-reminder>');
      expect(result[0]?.parts[1]).toHaveProperty('type', 'text');
      // oxlint-disable-next-line no-unsafe-optional-chaining -- test assertion with preceding length check
      expect((result[0]?.parts[1] as { type: 'text'; text: string }).text).toBe('Check this image');
      expect(result[0]?.parts[2]).toHaveProperty('type', 'file');
    });

    it('should add context only once even with multiple text parts', () => {
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

      // Context is only in the first part, original parts are unchanged
      expect(result[0]?.parts).toHaveLength(3);
      // oxlint-disable-next-line no-unsafe-optional-chaining -- test assertion with preceding length check
      expect((result[0]?.parts[0] as { type: 'text'; text: string }).text).toContain('<system-reminder>');
      // oxlint-disable-next-line no-unsafe-optional-chaining -- test assertion with preceding length check
      expect((result[0]?.parts[1] as { type: 'text'; text: string }).text).toBe('Part one');
      // oxlint-disable-next-line no-unsafe-optional-chaining -- test assertion with preceding length check
      expect((result[0]?.parts[2] as { type: 'text'; text: string }).text).toBe('Part two');
    });

    it('should not mutate original messages array', () => {
      const originalMessage = createUserMessage('Original text');
      const messages = [originalMessage];

      const result = injectSnapshotContext(messages, fullSnapshot);

      expect(result).not.toBe(messages);
      expect(result[0]).not.toBe(originalMessage);
      expect((originalMessage.parts[0] as { type: 'text'; text: string }).text).toBe('Original text');
    });

    it('should prepend text part with editor context when message has no text parts', () => {
      const messageWithOnlyFile: UIMessage = {
        id: 'msg-1',
        role: 'user',
        parts: [
          {
            type: 'file',
            mediaType: 'image/png',
            url: 'https://example.com/image.png',
          },
        ],
      };
      const messages = [messageWithOnlyFile];

      const result = injectSnapshotContext(messages, fullSnapshot);

      // Context prepended as first part, then original file part
      expect(result[0]?.parts).toHaveLength(2);
      expect(result[0]?.parts[0]).toHaveProperty('type', 'text');
      // oxlint-disable-next-line no-unsafe-optional-chaining -- test assertion with preceding length check
      expect((result[0]?.parts[0] as { type: 'text'; text: string }).text).toContain('<system-reminder>');
      // oxlint-disable-next-line no-unsafe-optional-chaining -- test assertion with preceding length check
      expect((result[0]?.parts[0] as { type: 'text'; text: string }).text).toContain('<active_file>');
      // oxlint-disable-next-line no-unsafe-optional-chaining -- test assertion with preceding length check
      expect((result[0]?.parts[0] as { type: 'text'; text: string }).text).toContain('<project_layout>');
      expect(result[0]?.parts[1]).toHaveProperty('type', 'file');
    });
  });

  // ===================================================================
  // R11: Universal <system-reminder> container (Finding 11)
  // ===================================================================

  describe('R11: universal system-reminder container', () => {
    it('should wrap editor context in <system-reminder> tags', () => {
      const messages = [createUserMessage('Hello')];
      const result = injectSnapshotContext(messages, fullSnapshot);
      const contextPart = result[0]?.parts[0] as { type: 'text'; text: string };

      expect(contextPart.text).toContain('<system-reminder>');
      expect(contextPart.text).toContain('</system-reminder>');
      expect(contextPart.text).not.toContain('<editor_context>');
    });
  });

  describe('context formatting', () => {
    it('should format active file context correctly', () => {
      const snapshot: ChatSnapshot = {
        activeFile: { path: 'lib/shapes.scad', name: 'shapes.scad' },
      };
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, snapshot);
      const contextPart = result[0]?.parts[0] as { type: 'text'; text: string };

      expect(contextPart.text).toContain('The file currently being rendered by the CAD engine: lib/shapes.scad');
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
      const contextPart = result[0]?.parts[0] as { type: 'text'; text: string };

      expect(contextPart.text).toContain('Files currently open in the editor tabs: a.scad, b.scad, c.scad');
    });

    it('should wrap all context in system-reminder tags', () => {
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, fullSnapshot);
      const contextPart = result[0]?.parts[0] as { type: 'text'; text: string };

      expect(contextPart.text).toMatch(/^<system-reminder>\n/);
      expect(contextPart.text).toMatch(/<\/system-reminder>\n\n$/);
    });

    it('should end context part with double newline', () => {
      const messages = [createUserMessage('My question')];

      const result = injectSnapshotContext(messages, fullSnapshot);
      const contextPart = result[0]?.parts[0] as { type: 'text'; text: string };
      const originalPart = result[0]?.parts[1] as { type: 'text'; text: string };

      expect(contextPart.text).toMatch(/<\/system-reminder>\n\n$/);
      expect(originalPart.text).toBe('My question');
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
      const contextPart = result[0]?.parts[0] as { type: 'text'; text: string };

      // Should have project root
      expect(contextPart.text).toContain('/project/');
      // Should have directory with trailing slash
      expect(contextPart.text).toContain('lib/');
      // Should have files with sizes
      expect(contextPart.text).toContain('shapes.scad (2KB)');
      expect(contextPart.text).toContain('utils.scad (1KB)');
      expect(contextPart.text).toContain('main.scad (5KB)');
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
      const contextPart = result[0]?.parts[0] as { type: 'text'; text: string };

      const libraryIndex = contextPart.text.indexOf('lib/');
      const mainFileIndex = contextPart.text.indexOf('main.scad');

      // Directory should come before file
      expect(libraryIndex).toBeLessThan(mainFileIndex);
    });

    it('should show empty message for empty fileTree', () => {
      const snapshot: ChatSnapshot = {
        fileTree: [],
        activeFile: { path: 'test.scad', name: 'test.scad' },
      };
      const messages = [createUserMessage('Hello')];

      const result = injectSnapshotContext(messages, snapshot);
      const contextPart = result[0]?.parts[0] as { type: 'text'; text: string };

      // Should not have project_layout for empty tree
      expect(contextPart.text).not.toContain('<project_layout>');
      // Should still have active file
      expect(contextPart.text).toContain('<active_file>');
    });
  });
});
