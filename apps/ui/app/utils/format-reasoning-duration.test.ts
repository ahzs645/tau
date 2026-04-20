import { describe, it, expect } from 'vitest';
import { formatReasoningDuration } from '#utils/format-reasoning-duration.js';

describe('formatReasoningDuration', () => {
  describe('Thought (default verb)', () => {
    it('should render "Thought briefly" for 0ms', () => {
      expect(formatReasoningDuration(0)).toBe('Thought briefly');
    });

    it('should render "Thought briefly" for 999ms (just under the 1s threshold)', () => {
      expect(formatReasoningDuration(999)).toBe('Thought briefly');
    });

    it('should render "Thought for 1s" at the 1000ms boundary', () => {
      expect(formatReasoningDuration(1000)).toBe('Thought for 1s');
    });

    it('should round 1500ms up to "Thought for 2s"', () => {
      expect(formatReasoningDuration(1500)).toBe('Thought for 2s');
    });

    it('should render "Thought for 59s" for 59_499ms', () => {
      expect(formatReasoningDuration(59_499)).toBe('Thought for 59s');
    });

    it('should render "Thought for 60s" for 59_999ms (still in seconds branch)', () => {
      expect(formatReasoningDuration(59_999)).toBe('Thought for 60s');
    });

    it('should render "Thought for 1m" at the 60_000ms boundary', () => {
      expect(formatReasoningDuration(60_000)).toBe('Thought for 1m');
    });

    it('should render "Thought for 1m 1s" for 60_500ms (rounds to 61s → 1m 1s)', () => {
      expect(formatReasoningDuration(60_500)).toBe('Thought for 1m 1s');
    });

    it('should render "Thought for 2m 5s" for 125_000ms', () => {
      expect(formatReasoningDuration(125_000)).toBe('Thought for 2m 5s');
    });

    it('should render "Thought for 2m" (no trailing 0s) for exactly 120_000ms', () => {
      expect(formatReasoningDuration(120_000)).toBe('Thought for 2m');
    });

    it('should accept the explicit verb option', () => {
      expect(formatReasoningDuration(2000, { verb: 'Thought' })).toBe('Thought for 2s');
    });
  });

  describe('Thinking', () => {
    it('should render "Thinking…" for 0ms', () => {
      expect(formatReasoningDuration(0, { verb: 'Thinking' })).toBe('Thinking…');
    });

    it('should render "Thinking…" for 999ms (just under the 1s threshold)', () => {
      expect(formatReasoningDuration(999, { verb: 'Thinking' })).toBe('Thinking…');
    });

    it('should render "Thinking for 1s" at the 1000ms boundary', () => {
      expect(formatReasoningDuration(1000, { verb: 'Thinking' })).toBe('Thinking for 1s');
    });

    it('should render "Thinking for 1m" at the 60_000ms boundary', () => {
      expect(formatReasoningDuration(60_000, { verb: 'Thinking' })).toBe('Thinking for 1m');
    });

    it('should render "Thinking for 2m 5s" for 125_000ms', () => {
      expect(formatReasoningDuration(125_000, { verb: 'Thinking' })).toBe('Thinking for 2m 5s');
    });
  });
});
