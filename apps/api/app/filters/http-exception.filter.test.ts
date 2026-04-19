/* oxlint-disable eslint-plugin-promise/prefer-await-to-then, eslint-plugin-promise/valid-params -- filter.catch() is a method name, not Promise.catch() */
/* oxlint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-confusing-void-expression -- test mock casts */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';
import * as otelApi from '@opentelemetry/api';
import { HttpExceptionFilter } from '#filters/http-exception.filter.js';

function createMockArgumentsHost(url = '/test') {
  const mockResponse = {
    header: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };

  const mockRequest = {
    url,
    id: 'req_test_123',
    headers: {},
  };

  return {
    switchToHttp: vi.fn().mockReturnValue({
      getResponse: vi.fn().mockReturnValue(mockResponse),
      getRequest: vi.fn().mockReturnValue(mockRequest),
    }),
    response: mockResponse,
    request: mockRequest,
  };
}

describe('HttpExceptionFilter OTEL integration', () => {
  let filter: HttpExceptionFilter;
  let mockSpan: { setStatus: ReturnType<typeof vi.fn>; recordException: ReturnType<typeof vi.fn> };
  let getSpanSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    mockSpan = {
      setStatus: vi.fn(),
      recordException: vi.fn(),
    };
    getSpanSpy = vi.spyOn(otelApi.trace, 'getSpan');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should annotate OTEL span with error status for 500 errors', () => {
    getSpanSpy.mockReturnValue(mockSpan as unknown as otelApi.Span);

    const host = createMockArgumentsHost();
    const exception = new Error('internal failure');

    filter.catch(exception, host as any);

    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: otelApi.SpanStatusCode.ERROR,
      message: 'Internal server error',
    });
    expect(mockSpan.recordException).toHaveBeenCalledWith(exception);
  });

  it('should annotate OTEL span for HttpException with 5xx status', () => {
    getSpanSpy.mockReturnValue(mockSpan as unknown as otelApi.Span);

    const host = createMockArgumentsHost();
    const exception = new HttpException('Service unavailable', HttpStatus.SERVICE_UNAVAILABLE);

    filter.catch(exception, host as any);

    expect(mockSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: otelApi.SpanStatusCode.ERROR }));
  });

  it('should NOT annotate OTEL span for 4xx errors', () => {
    getSpanSpy.mockReturnValue(mockSpan as unknown as otelApi.Span);

    const host = createMockArgumentsHost();
    const exception = new HttpException('Not Found', HttpStatus.NOT_FOUND);

    filter.catch(exception, host as any);

    expect(mockSpan.setStatus).not.toHaveBeenCalled();
    expect(mockSpan.recordException).not.toHaveBeenCalled();
  });

  it('should NOT annotate OTEL span for 400 Bad Request', () => {
    getSpanSpy.mockReturnValue(mockSpan as unknown as otelApi.Span);

    const host = createMockArgumentsHost();
    const exception = new HttpException('Bad request', HttpStatus.BAD_REQUEST);

    filter.catch(exception, host as any);

    expect(mockSpan.setStatus).not.toHaveBeenCalled();
  });

  it('should handle case when no active OTEL span exists', () => {
    getSpanSpy.mockReturnValue(undefined);

    const host = createMockArgumentsHost();
    const exception = new Error('server crash');

    expect(() => filter.catch(exception, host as any)).not.toThrow();
  });

  it('should not call recordException for non-Error 5xx exceptions', () => {
    getSpanSpy.mockReturnValue(mockSpan as unknown as otelApi.Span);

    const host = createMockArgumentsHost();
    const exception = 'string error';

    filter.catch(exception, host as any);

    expect(mockSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: otelApi.SpanStatusCode.ERROR }));
    expect(mockSpan.recordException).not.toHaveBeenCalled();
  });
});
