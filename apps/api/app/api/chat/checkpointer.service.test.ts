import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CheckpointerService } from '#api/chat/checkpointer.service.js';

// Define mock functions using vi.hoisted to ensure they're available before vi.mock runs
const { mockSetup, mockEnd, mockFromConnString } = vi.hoisted(() => {
  const mockSetup = vi.fn().mockResolvedValue(undefined);
  const mockEnd = vi.fn().mockResolvedValue(undefined);
  const mockFromConnString = vi.fn(() => ({
    setup: mockSetup,
    end: mockEnd,
  }));
  return { mockSetup, mockEnd, mockFromConnString };
});

vi.mock('@langchain/langgraph-checkpoint-postgres', () => ({
  // eslint-disable-next-line @typescript-eslint/naming-convention -- Langchain convention.
  PostgresSaver: {
    fromConnString: mockFromConnString,
  },
}));

describe('CheckpointerService', () => {
  let service: CheckpointerService;
  let module: TestingModule;

  const mockConfigService = {
    get: vi.fn(() => 'postgres://test:test@localhost:5432/test'),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [CheckpointerService, { provide: ConfigService, useValue: mockConfigService }],
    }).compile();

    service = moduleRef.get<CheckpointerService>(CheckpointerService);
    module = moduleRef;
  });

  afterEach(async () => {
    await module.close();
  });

  describe('onModuleInit', () => {
    it('should create PostgresSaver connection on module initialization', async () => {
      // Act
      await service.onModuleInit();

      // Assert
      expect(mockFromConnString).toHaveBeenCalledTimes(1);
      expect(mockFromConnString).toHaveBeenCalledWith('postgres://test:test@localhost:5432/test', {
        schema: 'langgraph',
      });
      expect(mockSetup).toHaveBeenCalledTimes(1);
    });

    it('should get database URL from ConfigService', async () => {
      // Act
      await service.onModuleInit();

      // Assert
      expect(mockConfigService.get).toHaveBeenCalledWith('DATABASE_URL', { infer: true });
    });
  });

  describe('getCheckpointer', () => {
    it('should return the initialized checkpointer instance', async () => {
      // Arrange
      await service.onModuleInit();

      // Act
      const first = service.getCheckpointer();
      const second = service.getCheckpointer();

      // Assert - same instance returned
      expect(first).toBe(second);
      expect(first).toEqual({ setup: mockSetup, end: mockEnd });
    });
  });

  describe('onModuleDestroy', () => {
    it('should close the checkpointer connection', async () => {
      // Arrange
      await service.onModuleInit();

      // Act
      await service.onModuleDestroy();

      // Assert
      expect(mockEnd).toHaveBeenCalledTimes(1);
    });
  });

  describe('singleton behavior', () => {
    it('should provide consistent checkpointer instance across multiple calls', async () => {
      // Arrange
      await service.onModuleInit();

      // Act - simulate multiple requests getting the checkpointer
      const instances = Array.from({ length: 10 }, () => service.getCheckpointer());

      // Assert - all instances are the same
      const firstInstance = instances[0];
      for (const instance of instances) {
        expect(instance).toBe(firstInstance);
      }

      // Only one connection was created
      expect(mockFromConnString).toHaveBeenCalledTimes(1);
    });
  });
});
