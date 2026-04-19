import { describe, it, expect } from 'vitest';
import {
  BLANKET_DISABLE_PATTERN,
  DIRECTIVE_WITH_RULES_PATTERN,
  hasRuleNames,
  isDisableComment,
  normaliseCommentLine,
  isDirectiveLine,
  getCommentLines,
} from './disable-comment.utils.js';

describe('disable-comment.utils', () => {
  // ===================================================================
  // BLANKET_DISABLE_PATTERN
  // ===================================================================

  describe('BLANKET_DISABLE_PATTERN', () => {
    it('should match eslint-disable and capture remaining text', () => {
      const match = BLANKET_DISABLE_PATTERN.exec('eslint-disable no-console');
      expect(match).not.toBeNull();
      expect(match?.[1]).toBe('no-console');
    });

    it('should match oxlint-disable and capture remaining text', () => {
      const match = BLANKET_DISABLE_PATTERN.exec('oxlint-disable no-console');
      expect(match).not.toBeNull();
      expect(match?.[1]).toBe('no-console');
    });

    it('should match eslint-disable-next-line variant', () => {
      const match = BLANKET_DISABLE_PATTERN.exec('eslint-disable-next-line no-unused-vars');
      expect(match).not.toBeNull();
      expect(match?.[1]).toBe('no-unused-vars');
    });

    it('should match eslint-disable-line variant', () => {
      const match = BLANKET_DISABLE_PATTERN.exec('eslint-disable-line no-console');
      expect(match).not.toBeNull();
      expect(match?.[1]).toBe('no-console');
    });

    it('should match blanket disable with no rules', () => {
      const match = BLANKET_DISABLE_PATTERN.exec('eslint-disable');
      expect(match).not.toBeNull();
      expect(match?.[1]).toBe('');
    });

    it('should match with leading whitespace', () => {
      const match = BLANKET_DISABLE_PATTERN.exec('  eslint-disable no-console');
      expect(match).not.toBeNull();
      expect(match?.[1]).toBe('no-console');
    });

    it('should not match unrelated comments', () => {
      const match = BLANKET_DISABLE_PATTERN.exec('This is a normal comment');
      expect(match).toBeNull();
    });
  });

  // ===================================================================
  // DIRECTIVE_WITH_RULES_PATTERN
  // ===================================================================

  describe('DIRECTIVE_WITH_RULES_PATTERN', () => {
    it('should match when there is at least one non-whitespace char after directive', () => {
      const match = DIRECTIVE_WITH_RULES_PATTERN.exec('eslint-disable no-console');
      expect(match).not.toBeNull();
      expect(match?.[1]).toBe('no-console');
    });

    it('should not match blanket disable with no content after keyword', () => {
      const match = DIRECTIVE_WITH_RULES_PATTERN.exec('eslint-disable');
      expect(match).toBeNull();
    });

    it('should match blanket disable with trailing whitespace (captures empty remainder)', () => {
      const match = DIRECTIVE_WITH_RULES_PATTERN.exec('eslint-disable   ');
      expect(match).not.toBeNull();
      expect(match?.[1]?.trim()).toBe('');
    });
  });

  // ===================================================================
  // hasRuleNames
  // ===================================================================

  describe('hasRuleNames', () => {
    it('should return true when rules are specified', () => {
      expect(hasRuleNames('eslint-disable no-console')).toBe(true);
    });

    it('should return true for scoped rule names', () => {
      expect(hasRuleNames('eslint-disable @typescript-eslint/no-unused-vars')).toBe(true);
    });

    it('should return false for blanket disable', () => {
      expect(hasRuleNames('eslint-disable')).toBe(false);
    });

    it('should return false when only a description follows after --', () => {
      expect(hasRuleNames('eslint-disable -- some reason')).toBe(false);
    });

    it('should return true for non-directive text', () => {
      expect(hasRuleNames('some random comment text')).toBe(true);
    });

    it('should return true when rules appear before the -- separator', () => {
      expect(hasRuleNames('eslint-disable no-console -- reason here')).toBe(true);
    });

    it('should return false for oxlint-disable blanket', () => {
      expect(hasRuleNames('oxlint-disable')).toBe(false);
    });

    it('should return false for oxlint-disable-next-line blanket', () => {
      expect(hasRuleNames('oxlint-disable-next-line')).toBe(false);
    });
  });

  // ===================================================================
  // isDisableComment
  // ===================================================================

  describe('isDisableComment', () => {
    it('should return true for eslint-disable comment', () => {
      expect(isDisableComment({ value: 'eslint-disable no-console', type: 'Line' })).toBe(true);
    });

    it('should return true for oxlint-disable comment', () => {
      expect(isDisableComment({ value: 'oxlint-disable no-console', type: 'Line' })).toBe(true);
    });

    it('should return true for eslint-disable-next-line comment', () => {
      expect(isDisableComment({ value: 'eslint-disable-next-line no-console', type: 'Line' })).toBe(true);
    });

    it('should return false for normal comment', () => {
      expect(isDisableComment({ value: 'This is a normal comment', type: 'Line' })).toBe(false);
    });

    it('should return true for block comments containing eslint-disable', () => {
      expect(isDisableComment({ value: ' eslint-disable no-console ', type: 'Block' })).toBe(true);
    });
  });

  // ===================================================================
  // normaliseCommentLine
  // ===================================================================

  describe('normaliseCommentLine', () => {
    it('should strip leading star prefix from JSDoc lines', () => {
      expect(normaliseCommentLine(' * eslint-disable no-console')).toBe('eslint-disable no-console');
    });

    it('should trim whitespace', () => {
      expect(normaliseCommentLine('  some content  ')).toBe('some content');
    });

    it('should handle lines with only a star marker', () => {
      expect(normaliseCommentLine(' * ')).toBe('');
    });

    it('should return the content unchanged when no star prefix', () => {
      expect(normaliseCommentLine('eslint-disable no-console')).toBe('eslint-disable no-console');
    });
  });

  // ===================================================================
  // isDirectiveLine
  // ===================================================================

  describe('isDirectiveLine', () => {
    it('should return true for eslint-disable directive', () => {
      expect(isDirectiveLine({ value: 'eslint-disable no-console', type: 'Line' })).toBe(true);
    });

    it('should return true for oxlint-disable directive', () => {
      expect(isDirectiveLine({ value: 'oxlint-disable no-console', type: 'Line' })).toBe(true);
    });

    it('should return true for block comment with star prefix', () => {
      expect(isDirectiveLine({ value: ' * eslint-disable no-console', type: 'Block' })).toBe(true);
    });

    it('should return false for non-directive comment', () => {
      expect(isDirectiveLine({ value: 'just a comment', type: 'Line' })).toBe(false);
    });

    it('should return true for eslint-disable-next-line', () => {
      expect(
        isDirectiveLine({ value: 'eslint-disable-next-line @typescript-eslint/no-unsafe-assignment', type: 'Line' }),
      ).toBe(true);
    });

    it('should return true for eslint-disable-line', () => {
      expect(isDirectiveLine({ value: 'eslint-disable-line no-console', type: 'Line' })).toBe(true);
    });
  });

  // ===================================================================
  // getCommentLines
  // ===================================================================

  describe('getCommentLines', () => {
    it('should return single-element array for line comments', () => {
      const result = getCommentLines({ value: 'eslint-disable no-console', type: 'Line' });
      expect(result).toEqual(['eslint-disable no-console']);
    });

    it('should split block comments on newlines', () => {
      const result = getCommentLines({
        value: 'line one\nline two\nline three',
        type: 'Block',
      });
      expect(result).toEqual(['line one', 'line two', 'line three']);
    });

    it('should return single-element array for single-line block comment', () => {
      const result = getCommentLines({ value: ' eslint-disable no-console ', type: 'Block' });
      expect(result).toEqual([' eslint-disable no-console ']);
    });
  });
});
