import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import type { Observation, VisualTestRequirement, TestModelOutput } from '@taucad/chat';
import { AnalysisController } from '#api/analysis/analysis.controller.js';
import { AnalysisService } from '#api/analysis/analysis.service.js';
import { AuthGuard } from '#auth/auth.guard.js';

describe('AnalysisController', () => {
  let controller: AnalysisController;
  let analysisService: AnalysisService;
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

  function createMockRequirements(): VisualTestRequirement[] {
    return [
      { id: 'test-1', description: 'Requirement 1', type: 'visual' },
      { id: 'test-2', description: 'Requirement 2', type: 'visual' },
    ];
  }

  beforeEach(async () => {
    vi.clearAllMocks();

    const mockAnalysisService = {
      runVisualTests: vi.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AnalysisController],
      providers: [
        {
          provide: AnalysisService,
          useValue: mockAnalysisService,
        },
        Reflector,
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<AnalysisController>(AnalysisController);
    analysisService = moduleRef.get<AnalysisService>(AnalysisService);
    module = moduleRef;
  });

  afterEach(async () => {
    await module.close();
  });

  describe('runVisualTests', () => {
    it('should delegate to analysisService with correct parameters', async () => {
      // Arrange
      const observations = createMockObservations();
      const requirements = createMockRequirements();
      const mockResult: TestModelOutput = {
        failures: [],
        passes: [{ id: 'test-1', requirement: 'Requirement 1' }],
        passed: 1,
        total: 1,
      };

      vi.mocked(analysisService.runVisualTests).mockResolvedValue(mockResult);

      // Act
      const result = await controller.runVisualTests({ observations, requirements });

      // Assert
      expect(analysisService.runVisualTests).toHaveBeenCalledWith(observations, requirements);
      expect(analysisService.runVisualTests).toHaveBeenCalledTimes(1);
      expect(result).toBe(mockResult);
    });

    it('should propagate errors from analysisService', async () => {
      // Arrange
      const observations = createMockObservations();
      const requirements = createMockRequirements();

      vi.mocked(analysisService.runVisualTests).mockRejectedValue(new Error('LLM API connection failed'));

      // Act & Assert
      await expect(controller.runVisualTests({ observations, requirements })).rejects.toThrow(
        'LLM API connection failed',
      );
    });
  });
});
