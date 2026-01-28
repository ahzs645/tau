import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { VisualTestRequirement, Observation } from '@taucad/chat';
import { generateText } from 'ai';
import { AnalysisService } from '#api/analysis/analysis.service.js';

// Mock the AI SDK
vi.mock('ai', () => ({
  generateText: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/naming-convention -- AI SDK naming
  Output: {
    object: vi.fn((config: unknown) => config),
  },
}));

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn(() => 'mocked-model'),
}));

describe('AnalysisService', () => {
  let service: AnalysisService;
  let module: TestingModule;

  function createMockObservations(): Observation[] {
    return [
      { id: 'front', side: 'front', src: 'data:image/png;base64,front' },
      { id: 'back', side: 'back', src: 'data:image/png;base64,back' },
      { id: 'right', side: 'right', src: 'data:image/png;base64,right' },
      { id: 'left', side: 'left', src: 'data:image/png;base64,left' },
      { id: 'top', side: 'top', src: 'data:image/png;base64,top' },
      { id: 'bottom', side: 'bottom', src: 'data:image/png;base64,bottom' },
    ];
  }

  function createMockRequirements(count = 3): VisualTestRequirement[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `req-${i + 1}`,
      description: `Requirement ${i + 1} description`,
      type: 'visual' as const,
    }));
  }

  beforeEach(async () => {
    vi.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [AnalysisService],
    }).compile();

    service = moduleRef.get<AnalysisService>(AnalysisService);
    module = moduleRef;
  });

  afterEach(async () => {
    await module.close();
  });

  describe('runVisualTests', () => {
    it('should mark missing results as failed when LLM returns fewer results than requirements', async () => {
      // Arrange: 3 requirements but LLM only returns results for 1
      const observations = createMockObservations();
      const requirements = createMockRequirements(3);

      vi.mocked(generateText).mockResolvedValue({
        output: {
          results: [
            // Only return result for req-2, missing req-1 and req-3
            { id: 'req-2', status: 'passed', reason: null, suggestion: null },
          ],
        },
      } as never);

      // Act
      const result = await service.runVisualTests(observations, requirements);

      // Assert
      expect(result.total).toBe(3);
      expect(result.passed).toBe(1);
      expect(result.passes).toHaveLength(1);
      expect(result.failures).toHaveLength(2);

      // Check that the passed result is correct
      expect(result.passes[0]).toEqual({
        id: 'req-2',
        requirement: 'Requirement 2 description',
      });

      // Check that missing requirements are marked as failed
      const missingFailures = result.failures.filter((f) => f.reason.includes('No analysis result returned'));
      expect(missingFailures).toHaveLength(2);

      const failureIds = result.failures.map((f) => f.id);
      expect(failureIds).toContain('req-1');
      expect(failureIds).toContain('req-3');

      // Verify the failure messages are helpful
      for (const failure of missingFailures) {
        expect(failure.reason).toBe('No analysis result returned for this requirement');
        expect(failure.suggestion).toBe(
          'This is a fatal error. The LLM failed to return a result for this requirement.',
        );
      }
    });

    it('should handle when LLM returns empty results array', async () => {
      // Arrange
      const observations = createMockObservations();
      const requirements = createMockRequirements(2);

      vi.mocked(generateText).mockResolvedValue({
        output: {
          results: [], // LLM returns no results at all
        },
      } as never);

      // Act
      const result = await service.runVisualTests(observations, requirements);

      // Assert
      expect(result.total).toBe(2);
      expect(result.passed).toBe(0);
      expect(result.passes).toHaveLength(0);
      expect(result.failures).toHaveLength(2);

      // All requirements should be marked as failed due to missing results
      for (const failure of result.failures) {
        expect(failure.reason).toBe('No analysis result returned for this requirement');
      }
    });

    it('should correctly process all results when LLM returns complete response', async () => {
      // Arrange
      const observations = createMockObservations();
      const requirements = createMockRequirements(3);

      vi.mocked(generateText).mockResolvedValue({
        output: {
          results: [
            { id: 'req-1', status: 'passed', reason: null, suggestion: null },
            { id: 'req-2', status: 'failed', reason: 'Test failed', suggestion: 'Fix it' },
            { id: 'req-3', status: 'passed', reason: null, suggestion: null },
          ],
        },
      } as never);

      // Act
      const result = await service.runVisualTests(observations, requirements);

      // Assert
      expect(result.total).toBe(3);
      expect(result.passed).toBe(2);
      expect(result.passes).toHaveLength(2);
      expect(result.failures).toHaveLength(1);

      expect(result.failures[0]).toEqual({
        id: 'req-2',
        requirement: 'Requirement 2 description',
        reason: 'Test failed',
        suggestion: 'Fix it',
      });
    });

    it('should use requirement description even for missing results', async () => {
      // Arrange
      const observations = createMockObservations();
      const requirements: VisualTestRequirement[] = [
        { id: 'custom-id', description: 'Custom description for testing', type: 'visual' },
      ];

      vi.mocked(generateText).mockResolvedValue({
        output: {
          results: [], // LLM returns no results
        },
      } as never);

      // Act
      const result = await service.runVisualTests(observations, requirements);

      // Assert
      expect(result.failures[0]?.requirement).toBe('Custom description for testing');
    });

    it('should return all requirements as failures when LLM call throws an error', async () => {
      // Arrange
      const observations = createMockObservations();
      const requirements = createMockRequirements(2);

      vi.mocked(generateText).mockRejectedValue(new Error('API connection failed'));

      // Act
      const result = await service.runVisualTests(observations, requirements);

      // Assert
      expect(result.total).toBe(2);
      expect(result.passed).toBe(0);
      expect(result.passes).toHaveLength(0);
      expect(result.failures).toHaveLength(2);

      for (const failure of result.failures) {
        expect(failure.reason).toContain('Analysis error: API connection failed');
        expect(failure.suggestion).toBe('This is a fatal error. The API request failed.');
      }
    });

    it('should sort observations by view order before sending to LLM', async () => {
      // Arrange: observations in random order
      const observations: Observation[] = [
        { id: 'top', side: 'top', src: 'data:image/png;base64,top' },
        { id: 'front', side: 'front', src: 'data:image/png;base64,front' },
        { id: 'bottom', side: 'bottom', src: 'data:image/png;base64,bottom' },
        { id: 'back', side: 'back', src: 'data:image/png;base64,back' },
        { id: 'left', side: 'left', src: 'data:image/png;base64,left' },
        { id: 'right', side: 'right', src: 'data:image/png;base64,right' },
      ];
      const requirements = createMockRequirements(1);

      vi.mocked(generateText).mockResolvedValue({
        output: {
          results: [{ id: 'req-1', status: 'passed', reason: null, suggestion: null }],
        },
      } as never);

      // Act
      await service.runVisualTests(observations, requirements);

      // Assert: verify the images are passed in correct order
      const callArgs = vi.mocked(generateText).mock.calls[0]?.[0];
      const messages = callArgs?.messages as Array<{ content: Array<{ type: string; image?: string }> }>;
      const imageContent = messages[0]?.content.filter((c) => c.type === 'image');

      expect(imageContent).toHaveLength(6);
      expect(imageContent?.[0]?.image).toBe('data:image/png;base64,front');
      expect(imageContent?.[1]?.image).toBe('data:image/png;base64,back');
      expect(imageContent?.[2]?.image).toBe('data:image/png;base64,right');
      expect(imageContent?.[3]?.image).toBe('data:image/png;base64,left');
      expect(imageContent?.[4]?.image).toBe('data:image/png;base64,top');
      expect(imageContent?.[5]?.image).toBe('data:image/png;base64,bottom');
    });

    it('should throw an error when any view is missing', async () => {
      // Arrange: only 2 out of 6 required views
      const partialObservations: Observation[] = [
        { id: 'front', side: 'front', src: 'data:image/png;base64,front' },
        { id: 'top', side: 'top', src: 'data:image/png;base64,top' },
      ];
      const requirements = createMockRequirements(1);

      // Act & Assert
      await expect(service.runVisualTests(partialObservations, requirements)).rejects.toThrow(
        'Missing required views: back, right, left, bottom. All 6 orthographic views (front, back, right, left, top, bottom) are required for accurate analysis.',
      );

      // Verify LLM was never called
      expect(generateText).not.toHaveBeenCalled();
    });

    it('should throw an error listing all missing views', async () => {
      // Arrange: missing just one view
      const observations: Observation[] = [
        { id: 'front', side: 'front', src: 'data:image/png;base64,front' },
        { id: 'back', side: 'back', src: 'data:image/png;base64,back' },
        { id: 'right', side: 'right', src: 'data:image/png;base64,right' },
        { id: 'left', side: 'left', src: 'data:image/png;base64,left' },
        { id: 'top', side: 'top', src: 'data:image/png;base64,top' },
        // Bottom is missing
      ];
      const requirements = createMockRequirements(1);

      // Act & Assert
      await expect(service.runVisualTests(observations, requirements)).rejects.toThrow(
        'Missing required views: bottom',
      );

      // Verify LLM was never called
      expect(generateText).not.toHaveBeenCalled();
    });

    it('should provide default reason and suggestion when LLM omits them for failures', async () => {
      // Arrange
      const observations = createMockObservations();
      const requirements = createMockRequirements(1);

      vi.mocked(generateText).mockResolvedValue({
        output: {
          results: [{ id: 'req-1', status: 'failed', reason: null, suggestion: null }],
        },
      } as never);

      // Act
      const result = await service.runVisualTests(observations, requirements);

      // Assert
      expect(result.failures[0]).toEqual({
        id: 'req-1',
        requirement: 'Requirement 1 description',
        reason: 'No reason provided',
        suggestion: 'Review the model',
      });
    });
  });
});
