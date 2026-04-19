import { describe, expect, it } from 'vitest';
import type { MyUIMessage } from '@taucad/chat';
import type { ActivityGroup } from '#utils/assistant-message-activity.js';
import {
  classifyActivityPart,
  groupAssistantParts,
  findActivityPrefixEnd,
  findLastMeaningfulPartIndex,
} from '#utils/assistant-message-activity.js';

type Parts = MyUIMessage['parts'];
type Part = Parts[number];

// ── Helpers ──────────────────────────────────────────────────────────────────

const textPart = (text = 'Hello'): Part => ({ type: 'text', text });
const reasoningPart = (text = 'Thinking...'): Part => ({ type: 'reasoning', text });
const stepStartPart = (): Part => ({ type: 'step-start' });

const toolPart = (toolType: string, state = 'output-available'): Part =>
  ({
    type: toolType,
    toolCallId: `call-${toolType}-${Math.random().toString(36).slice(2, 6)}`,
    state,
    input: {},
    output: {},
  }) as unknown as Part;

const readFilePart = (state?: string) => toolPart('tool-read_file', state);
const listDirectoryPart = (state?: string) => toolPart('tool-list_directory', state);
const grepPart = (state?: string) => toolPart('tool-grep', state);
const globPart = (state?: string) => toolPart('tool-glob_search', state);
const editFilePart = (state?: string) => toolPart('tool-edit_file', state);
const createFilePart = (state?: string) => toolPart('tool-create_file', state);
const deleteFilePart = (state?: string) => toolPart('tool-delete_file', state);
const editTestsPart = (state?: string) => toolPart('tool-edit_tests', state);
const webSearchPart = (state?: string) => toolPart('tool-web_search', state);
const webBrowserPart = (state?: string) => toolPart('tool-web_browser', state);
const testModelPart = (state?: string) => toolPart('tool-test_model', state);
const screenshotPart = (state?: string) => toolPart('tool-screenshot', state);
const kernelResultPart = (state?: string) => toolPart('tool-get_kernel_result', state);
const transferPart = (state?: string) => toolPart('tool-transfer_to_cad_expert', state);

const expectAggregated = (group: ActivityGroup) => {
  expect(group.kind).toBe('aggregated');
  if (group.kind !== 'aggregated') {
    throw new Error('Expected aggregated group');
  }
  return group;
};

// ── classifyActivityPart ─────────────────────────────────────────────────────

describe('classifyActivityPart', () => {
  it('should classify text parts as text', () => {
    expect(classifyActivityPart(textPart())).toBe('text');
  });

  it('should classify empty text parts as skip', () => {
    expect(classifyActivityPart(textPart(''))).toBe('skip');
  });

  it('should classify whitespace-only text parts as skip', () => {
    expect(classifyActivityPart(textPart('   '))).toBe('skip');
    expect(classifyActivityPart(textPart('\n\n  \t'))).toBe('skip');
  });

  it('should classify reasoning parts as reasoning', () => {
    expect(classifyActivityPart(reasoningPart())).toBe('reasoning');
  });

  it('should classify step-start as skip', () => {
    expect(classifyActivityPart(stepStartPart())).toBe('skip');
  });

  it('should classify data-usage as skip', () => {
    const part = { type: 'data-usage', data: {} } as unknown as Part;
    expect(classifyActivityPart(part)).toBe('skip');
  });

  it('should classify data-context-compaction as singleton', () => {
    const part = { type: 'data-context-compaction', data: {} } as unknown as Part;
    expect(classifyActivityPart(part)).toBe('data');
  });

  it('should classify data-context-usage as skip', () => {
    const part = { type: 'data-context-usage', data: {} } as unknown as Part;
    expect(classifyActivityPart(part)).toBe('skip');
  });

  it('should classify web_search and web_browser into research category', () => {
    expect(classifyActivityPart(webSearchPart())).toBe('research');
    expect(classifyActivityPart(webBrowserPart())).toBe('research');
  });

  it('should classify read_file, list_directory, grep, glob_search into research category', () => {
    expect(classifyActivityPart(readFilePart())).toBe('research');
    expect(classifyActivityPart(listDirectoryPart())).toBe('research');
    expect(classifyActivityPart(grepPart())).toBe('research');
    expect(classifyActivityPart(globPart())).toBe('research');
  });

  it('should classify edit_file, create_file, delete_file, edit_tests into write category', () => {
    expect(classifyActivityPart(editFilePart())).toBe('write');
    expect(classifyActivityPart(createFilePart())).toBe('write');
    expect(classifyActivityPart(deleteFilePart())).toBe('write');
    expect(classifyActivityPart(editTestsPart())).toBe('write');
  });

  it('should classify get_kernel_result, screenshot, test_model into cad category', () => {
    expect(classifyActivityPart(kernelResultPart())).toBe('cad');
    expect(classifyActivityPart(screenshotPart())).toBe('cad');
    expect(classifyActivityPart(testModelPart())).toBe('cad');
  });

  it('should classify transfer tools as transfer', () => {
    expect(classifyActivityPart(transferPart())).toBe('transfer');
  });
});

// ── groupAssistantParts ──────────────────────────────────────────────────────

describe('groupAssistantParts', () => {
  describe('singleton passthrough', () => {
    it('should pass text parts through as singletons', () => {
      const parts: Parts = [textPart('Hello')];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(1);
      const first = groups[0]!;
      expect(first.kind).toBe('singleton');
      if (first.kind === 'singleton') {
        expect(first.part.type).toBe('text');
      }
    });

    it('should pass reasoning parts through as singletons', () => {
      const parts: Parts = [reasoningPart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(1);
      expect(groups[0]!.kind).toBe('singleton');
    });

    it('should skip step-start parts entirely', () => {
      const parts: Parts = [stepStartPart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(0);
    });

    it('should skip data-usage parts entirely', () => {
      const parts: Parts = [{ type: 'data-usage', data: {} } as unknown as Part];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(0);
    });

    it('should skip empty text parts entirely', () => {
      const parts: Parts = [textPart('')];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(0);
    });

    it('should skip whitespace-only text parts entirely', () => {
      const parts: Parts = [textPart('   \n\t  ')];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(0);
    });

    it('should pass data-context-compaction as singleton', () => {
      const parts: Parts = [{ type: 'data-context-compaction', data: {} } as unknown as Part];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(1);
      expect(groups[0]!.kind).toBe('singleton');
    });

    it('should pass transfer tools as singletons', () => {
      const parts: Parts = [transferPart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(1);
      expect(groups[0]!.kind).toBe('singleton');
    });
  });

  describe('aggregation of consecutive tools', () => {
    it('should merge consecutive explore tools into one research group', () => {
      const parts: Parts = [readFilePart(), listDirectoryPart(), grepPart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(1);
      const group = expectAggregated(groups[0]!);
      expect(group.category).toBe('research');
      expect(group.parts).toHaveLength(3);
    });

    it('should merge consecutive web tools into one research group', () => {
      const parts: Parts = [webSearchPart(), webBrowserPart(), webSearchPart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(1);
      const group = expectAggregated(groups[0]!);
      expect(group.category).toBe('research');
      expect(group.parts).toHaveLength(3);
    });

    it('should aggregate interleaved explore and web tools into a single research group', () => {
      const parts: Parts = [readFilePart(), webSearchPart(), grepPart(), webBrowserPart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(1);
      const group = expectAggregated(groups[0]!);
      expect(group.category).toBe('research');
      expect(group.parts).toHaveLength(4);
    });

    it('should keep consecutive write tools as singletons', () => {
      const parts: Parts = [editFilePart(), createFilePart(), deleteFilePart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(3);
      for (const group of groups) {
        expect(group.kind).toBe('singleton');
        if (group.kind === 'singleton') {
          expect(group.category).toBe('write');
        }
      }
    });

    it('should keep consecutive cad tools as singletons', () => {
      const parts: Parts = [kernelResultPart(), screenshotPart(), testModelPart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(3);
      for (const group of groups) {
        expect(group.kind).toBe('singleton');
        if (group.kind === 'singleton') {
          expect(group.category).toBe('cad');
        }
      }
    });

    it('should keep a single research tool as an aggregated group with one part', () => {
      const parts: Parts = [readFilePart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(1);
      const group = expectAggregated(groups[0]!);
      expect(group.parts).toHaveLength(1);
    });
  });

  describe('group splitting', () => {
    it('should not merge research tools separated by text', () => {
      const parts: Parts = [readFilePart(), textPart('found something'), grepPart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(3);
      expect(groups[0]!.kind).toBe('aggregated');
      expect(groups[1]!.kind).toBe('singleton');
      expect(groups[2]!.kind).toBe('aggregated');
    });

    it('should split research from non-aggregatable categories', () => {
      const parts: Parts = [readFilePart(), listDirectoryPart(), editFilePart(), createFilePart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(3);
      expect(expectAggregated(groups[0]!).category).toBe('research');
      expect(groups[1]!.kind).toBe('singleton');
      expect(groups[2]!.kind).toBe('singleton');
      if (groups[1]!.kind === 'singleton') {
        expect(groups[1]!.category).toBe('write');
      }
      if (groups[2]!.kind === 'singleton') {
        expect(groups[2]!.category).toBe('write');
      }
    });

    it('should treat step-start as transparent — not splitting adjacent groups', () => {
      const parts: Parts = [readFilePart(), stepStartPart(), grepPart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(1);
      const group = expectAggregated(groups[0]!);
      expect(group.parts).toHaveLength(2);
    });

    it('should treat empty text as transparent — not splitting adjacent research tools', () => {
      const parts: Parts = [webSearchPart(), textPart(''), webSearchPart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(1);
      const group = expectAggregated(groups[0]!);
      expect(group.parts).toHaveLength(2);
    });

    it('should treat whitespace-only text as transparent — not splitting adjacent research tools', () => {
      const parts: Parts = [readFilePart(), textPart('   \n'), webSearchPart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(1);
      const group = expectAggregated(groups[0]!);
      expect(group.parts).toHaveLength(2);
    });
  });

  describe('complex sequences', () => {
    it('should handle reasoning, research, text answer sequence', () => {
      const parts: Parts = [
        reasoningPart(),
        readFilePart(),
        listDirectoryPart(),
        grepPart(),
        textPart('Here is my answer'),
      ];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(3);
      expect(groups[0]!.kind).toBe('singleton');
      expect(groups[1]!.kind).toBe('aggregated');
      expect(groups[2]!.kind).toBe('singleton');
    });

    it('should handle research, write singletons, text, research, text', () => {
      const parts: Parts = [
        readFilePart(),
        grepPart(),
        editFilePart(),
        createFilePart(),
        textPart('Made some changes'),
        readFilePart(),
        textPart('Final answer'),
      ];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(6);
      expect(expectAggregated(groups[0]!).category).toBe('research');
      expect(groups[1]!.kind).toBe('singleton');
      expect(groups[2]!.kind).toBe('singleton');
      expect(groups[3]!.kind).toBe('singleton');
      expect(groups[4]!.kind).toBe('aggregated');
      expect(groups[5]!.kind).toBe('singleton');
    });

    it('should preserve original part indices in aggregated groups', () => {
      const parts: Parts = [readFilePart(), stepStartPart(), grepPart(), textPart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(2);
      const group = expectAggregated(groups[0]!);
      expect(group.partIndices).toEqual([0, 2]);
    });

    it('should handle empty parts array', () => {
      const groups = groupAssistantParts([]);
      expect(groups).toHaveLength(0);
    });
  });

  describe('reasoning bridging', () => {
    it('should absorb a single reasoning part sandwiched between two research runs into one aggregated group', () => {
      const parts: Parts = [grepPart(), reasoningPart(), grepPart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(1);
      const group = expectAggregated(groups[0]!);
      expect(group.category).toBe('research');
      expect(group.parts).toHaveLength(3);
      expect(group.parts[1]!.type).toBe('reasoning');
      expect(group.summaryDetail).toBe('2 searches');
      expect(group.partIndices).toEqual([0, 1, 2]);
    });

    it('should keep leading reasoning as a separate singleton', () => {
      const parts: Parts = [reasoningPart(), grepPart(), grepPart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(2);
      expect(groups[0]!.kind).toBe('singleton');
      if (groups[0]!.kind === 'singleton') {
        expect(groups[0]!.category).toBe('reasoning');
      }
      const aggregated = expectAggregated(groups[1]!);
      expect(aggregated.parts).toHaveLength(2);
      expect(aggregated.summaryDetail).toBe('2 searches');
    });

    it('should keep trailing reasoning as a separate singleton when no research follows', () => {
      const parts: Parts = [grepPart(), grepPart(), reasoningPart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(2);
      const aggregated = expectAggregated(groups[0]!);
      expect(aggregated.parts).toHaveLength(2);
      expect(aggregated.summaryDetail).toBe('2 searches');
      expect(groups[1]!.kind).toBe('singleton');
      if (groups[1]!.kind === 'singleton') {
        expect(groups[1]!.category).toBe('reasoning');
      }
    });

    it('should absorb only sandwiched reasoning, leaving leading and trailing reasoning as singletons', () => {
      const parts: Parts = [reasoningPart('R1'), grepPart(), reasoningPart('R2'), grepPart(), reasoningPart('R3')];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(3);
      expect(groups[0]!.kind).toBe('singleton');
      if (groups[0]!.kind === 'singleton') {
        expect(groups[0]!.category).toBe('reasoning');
        expect(groups[0]!.partIndex).toBe(0);
      }
      const aggregated = expectAggregated(groups[1]!);
      expect(aggregated.parts).toHaveLength(3);
      expect(aggregated.parts[1]!.type).toBe('reasoning');
      expect(aggregated.partIndices).toEqual([1, 2, 3]);
      expect(aggregated.summaryDetail).toBe('2 searches');
      expect(groups[2]!.kind).toBe('singleton');
      if (groups[2]!.kind === 'singleton') {
        expect(groups[2]!.category).toBe('reasoning');
        expect(groups[2]!.partIndex).toBe(4);
      }
    });

    it('should not bridge across non-bridging singletons (write breaks the bridge)', () => {
      const parts: Parts = [grepPart(), editFilePart(), grepPart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(3);
      const first = expectAggregated(groups[0]!);
      expect(first.parts).toHaveLength(1);
      expect(groups[1]!.kind).toBe('singleton');
      if (groups[1]!.kind === 'singleton') {
        expect(groups[1]!.category).toBe('write');
      }
      const third = expectAggregated(groups[2]!);
      expect(third.parts).toHaveLength(1);
    });

    it('should not bridge across reasoning followed by a non-research part', () => {
      const parts: Parts = [grepPart(), reasoningPart(), editFilePart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(3);
      const aggregated = expectAggregated(groups[0]!);
      expect(aggregated.parts).toHaveLength(1);
      expect(groups[1]!.kind).toBe('singleton');
      if (groups[1]!.kind === 'singleton') {
        expect(groups[1]!.category).toBe('reasoning');
      }
      expect(groups[2]!.kind).toBe('singleton');
      if (groups[2]!.kind === 'singleton') {
        expect(groups[2]!.category).toBe('write');
      }
    });

    it('should compute summary detail from research parts only (reasoning excluded)', () => {
      const parts: Parts = [grepPart(), reasoningPart(), webSearchPart(), webBrowserPart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(1);
      const group = expectAggregated(groups[0]!);
      expect(group.summaryDetail).toBe('2 searches, 1 fetch');
      expect(group.summary).toBe('Explored 2 searches, 1 fetch');
    });

    it('should keep leading reasoning when the research run is a single part', () => {
      const parts: Parts = [reasoningPart(), grepPart()];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(2);
      expect(groups[0]!.kind).toBe('singleton');
      const aggregated = expectAggregated(groups[1]!);
      expect(aggregated.parts).toHaveLength(1);
    });

    it('should keep multiple consecutive trailing reasoning parts as singletons', () => {
      const parts: Parts = [grepPart(), reasoningPart('R1'), reasoningPart('R2')];
      const groups = groupAssistantParts(parts);

      expect(groups).toHaveLength(3);
      const aggregated = expectAggregated(groups[0]!);
      expect(aggregated.parts).toHaveLength(1);
      expect(groups[1]!.kind).toBe('singleton');
      if (groups[1]!.kind === 'singleton') {
        expect(groups[1]!.category).toBe('reasoning');
      }
      expect(groups[2]!.kind).toBe('singleton');
      if (groups[2]!.kind === 'singleton') {
        expect(groups[2]!.category).toBe('reasoning');
      }
    });
  });

  describe('findActivityPrefixEnd', () => {
    it('should return 0 when the first group is text', () => {
      const parts: Parts = [textPart('Hello')];
      const groups = groupAssistantParts(parts);

      expect(findActivityPrefixEnd(groups)).toBe(0);
    });

    it('should return groups.length when there is no text', () => {
      const parts: Parts = [reasoningPart(), readFilePart(), grepPart()];
      const groups = groupAssistantParts(parts);

      expect(findActivityPrefixEnd(groups)).toBe(groups.length);
    });

    it('should return the index of the first text singleton', () => {
      const parts: Parts = [reasoningPart(), readFilePart(), grepPart(), textPart('Answer')];
      const groups = groupAssistantParts(parts);

      // Groups: [reasoning singleton, research aggregated, text singleton]
      expect(findActivityPrefixEnd(groups)).toBe(2);
    });

    it('should treat reasoning as part of the activity prefix', () => {
      const parts: Parts = [reasoningPart(), textPart('Answer')];
      const groups = groupAssistantParts(parts);

      expect(findActivityPrefixEnd(groups)).toBe(1);
    });

    it('should ignore empty text when finding the prefix end', () => {
      const parts: Parts = [webSearchPart(), webSearchPart(), textPart('')];
      const groups = groupAssistantParts(parts);

      // Empty text is skipped at classification → not in groups → no real downstream text
      expect(findActivityPrefixEnd(groups)).toBe(groups.length);
    });
  });

  describe('findLastMeaningfulPartIndex', () => {
    it('should return -1 for an empty parts array', () => {
      expect(findLastMeaningfulPartIndex([])).toBe(-1);
    });

    it('should return -1 when every part classifies as skip', () => {
      const parts: Parts = [stepStartPart(), { type: 'data-usage', data: {} } as unknown as Part];
      expect(findLastMeaningfulPartIndex(parts)).toBe(-1);
    });

    it('should skip trailing data-usage / step-start / empty-text parts and return the last meaningful index', () => {
      const parts: Parts = [
        reasoningPart(),
        webSearchPart(),
        { type: 'data-usage', data: {} } as unknown as Part,
        stepStartPart(),
      ];
      expect(findLastMeaningfulPartIndex(parts)).toBe(1);
    });

    it('should return the index of a trailing reasoning part', () => {
      const parts: Parts = [webSearchPart(), reasoningPart()];
      expect(findLastMeaningfulPartIndex(parts)).toBe(1);
    });

    it('should return the index of a trailing web_search (screenshot scenario)', () => {
      const parts: Parts = [reasoningPart(), webSearchPart(), webSearchPart(), webSearchPart(), webSearchPart()];
      expect(findLastMeaningfulPartIndex(parts)).toBe(4);
    });

    it('should treat whitespace-only text as skip and ignore it for the last index', () => {
      const parts: Parts = [reasoningPart(), webSearchPart(), textPart('   \n\t')];
      expect(findLastMeaningfulPartIndex(parts)).toBe(1);
    });

    it('should return the last index when all parts are meaningful', () => {
      const parts: Parts = [reasoningPart(), webSearchPart(), textPart('Answer')];
      expect(findLastMeaningfulPartIndex(parts)).toBe(2);
    });
  });

  describe('summary generation', () => {
    it('should generate research summary for explore-only tools (files + searches)', () => {
      const parts: Parts = [readFilePart(), readFilePart(), grepPart()];
      const groups = groupAssistantParts(parts);

      const group = expectAggregated(groups[0]!);
      expect(group.summaryVerb).toBe('Explored');
      expect(group.summaryDetail).toBe('2 files, 1 search');
      expect(group.summary).toBe('Explored 2 files, 1 search');
    });

    it('should generate research summary for web-only tools (searches + fetches)', () => {
      const parts: Parts = [webSearchPart(), webSearchPart(), webBrowserPart()];
      const groups = groupAssistantParts(parts);

      const group = expectAggregated(groups[0]!);
      expect(group.summaryVerb).toBe('Explored');
      expect(group.summaryDetail).toBe('2 searches, 1 fetch');
      expect(group.summary).toBe('Explored 2 searches, 1 fetch');
    });

    it('should merge web + code searches into a single searches count', () => {
      const parts: Parts = [webSearchPart(), webSearchPart(), readFilePart(), grepPart()];
      const groups = groupAssistantParts(parts);

      const group = expectAggregated(groups[0]!);
      expect(group.summaryVerb).toBe('Explored');
      expect(group.summaryDetail).toBe('1 file, 3 searches');
      expect(group.summary).toBe('Explored 1 file, 3 searches');
    });

    it('should produce singular forms when count is 1 for each segment', () => {
      const parts: Parts = [webSearchPart(), webBrowserPart(), readFilePart()];
      const groups = groupAssistantParts(parts);

      const group = expectAggregated(groups[0]!);
      expect(group.summaryVerb).toBe('Explored');
      expect(group.summaryDetail).toBe('1 file, 1 search, 1 fetch');
      expect(group.summary).toBe('Explored 1 file, 1 search, 1 fetch');
    });

    it('should pluralize each segment when count is greater than 1', () => {
      const parts: Parts = [
        webSearchPart(),
        webSearchPart(),
        webBrowserPart(),
        webBrowserPart(),
        readFilePart(),
        readFilePart(),
        grepPart(),
        grepPart(),
      ];
      const groups = groupAssistantParts(parts);

      const group = expectAggregated(groups[0]!);
      expect(group.summaryVerb).toBe('Explored');
      expect(group.summaryDetail).toBe('2 files, 4 searches, 2 fetches');
      expect(group.summary).toBe('Explored 2 files, 4 searches, 2 fetches');
    });

    it('should order segments as files, searches, fetches', () => {
      const parts: Parts = [webBrowserPart(), grepPart(), readFilePart()];
      const groups = groupAssistantParts(parts);

      const group = expectAggregated(groups[0]!);
      expect(group.summaryDetail).toBe('1 file, 1 search, 1 fetch');
    });

    it('should always satisfy the invariant: summary equals summaryVerb + space + summaryDetail', () => {
      const fixtures: Parts[] = [
        [readFilePart()],
        [webSearchPart(), webBrowserPart()],
        [readFilePart(), webSearchPart(), grepPart()],
      ];

      for (const parts of fixtures) {
        const groups = groupAssistantParts(parts);
        const group = expectAggregated(groups[0]!);
        expect(group.summary).toBe(`${group.summaryVerb} ${group.summaryDetail}`);
      }
    });
  });
});
