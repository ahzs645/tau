import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolError } from '@taucad/chat/utils';
import { createWebBrowserTool } from '#api/tools/tools/tool-web-browser.js';
import type { ExtractedContent } from '#api/tools/utils/web-content-extractor.js';

const { mockFetchAndExtract } = vi.hoisted(() => ({
  mockFetchAndExtract: vi.fn<(url: string) => Promise<ExtractedContent>>(),
}));

vi.mock('#api/tools/utils/web-content-extractor.js', () => ({
  fetchAndExtract: mockFetchAndExtract,
}));

type CallInput = { urls: string[]; query?: string };

describe('WebBrowserTool', () => {
  beforeEach(() => {
    mockFetchAndExtract.mockReset();
  });

  const callTool = async (input: CallInput) => {
    const tool = createWebBrowserTool();
    return (tool as unknown as { _call(input: CallInput): Promise<Array<{ url: string; content: string }>> })._call(
      input,
    );
  };

  // =============================================================================
  // Successful extraction
  // =============================================================================

  describe('successful extraction', () => {
    it('should return extracted content for a single URL', async () => {
      mockFetchAndExtract.mockResolvedValueOnce({
        url: 'https://example.com',
        content: '# Hello World',
        contentType: 'text/html',
        bytes: 100,
      });

      const result = await callTool({ urls: ['https://example.com'] });

      expect(result).toEqual([{ url: 'https://example.com', content: '# Hello World' }]);
    });

    it('should return extracted content for multiple URLs', async () => {
      mockFetchAndExtract.mockResolvedValueOnce({
        url: 'https://a.com',
        content: 'Content A',
        contentType: 'text/html',
        bytes: 50,
      });
      mockFetchAndExtract.mockResolvedValueOnce({
        url: 'https://b.com',
        content: 'Content B',
        contentType: 'text/html',
        bytes: 60,
      });

      const result = await callTool({ urls: ['https://a.com', 'https://b.com'] });

      expect(result).toEqual([
        { url: 'https://a.com', content: 'Content A' },
        { url: 'https://b.com', content: 'Content B' },
      ]);
    });

    it('should call fetchAndExtract for each URL', async () => {
      mockFetchAndExtract.mockResolvedValue({
        url: 'https://example.com',
        content: 'content',
        contentType: 'text/html',
        bytes: 50,
      });

      await callTool({ urls: ['https://a.com', 'https://b.com', 'https://c.com'] });

      expect(mockFetchAndExtract).toHaveBeenCalledTimes(3);
      expect(mockFetchAndExtract).toHaveBeenCalledWith('https://a.com');
      expect(mockFetchAndExtract).toHaveBeenCalledWith('https://b.com');
      expect(mockFetchAndExtract).toHaveBeenCalledWith('https://c.com');
    });
  });

  // =============================================================================
  // Partial failure handling
  // =============================================================================

  describe('partial failure handling', () => {
    it('should include per-URL error entries when individual extractions fail', async () => {
      mockFetchAndExtract.mockResolvedValueOnce({
        url: 'https://good.com',
        content: 'Good content',
        contentType: 'text/html',
        bytes: 80,
      });
      mockFetchAndExtract.mockRejectedValueOnce(new Error('HTTP 403: Forbidden'));

      const result = await callTool({ urls: ['https://good.com', 'https://blocked.com'] });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ url: 'https://good.com', content: 'Good content' });
      expect(result[1]!.url).toBe('https://blocked.com');
      expect(result[1]!.content).toContain('Extraction failed');
    });

    it('should include error message in per-URL failure entries', async () => {
      mockFetchAndExtract.mockResolvedValueOnce({
        url: 'https://ok.com',
        content: 'OK',
        contentType: 'text/html',
        bytes: 20,
      });
      mockFetchAndExtract.mockRejectedValueOnce(new Error('Unsupported content type: image/png'));

      const result = await callTool({ urls: ['https://ok.com', 'https://img.com/photo.png'] });

      const failedEntry = result.find((r) => r.url === 'https://img.com/photo.png');
      expect(failedEntry).toBeDefined();
      expect(failedEntry!.content).toContain('Unsupported content type: image/png');
    });
  });

  // =============================================================================
  // Total failure
  // =============================================================================

  describe('total failure', () => {
    it('should throw TOOL_NO_RESULTS when all URLs fail', async () => {
      mockFetchAndExtract.mockRejectedValueOnce(new Error('HTTP 404: Not Found'));
      mockFetchAndExtract.mockRejectedValueOnce(new Error('HTTP 500: Internal Server Error'));

      try {
        await callTool({ urls: ['https://missing.com', 'https://broken.com'] });
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ToolError);
        expect((error as ToolError).data.errorCode).toBe('TOOL_NO_RESULTS');
      }
    });

    it('should include guidance to use web_search in error message', async () => {
      mockFetchAndExtract.mockRejectedValueOnce(new Error('fetch failed'));

      try {
        await callTool({ urls: ['https://unreachable.com'] });
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ToolError);
        expect((error as ToolError).data.message).toContain('web_search');
      }
    });
  });

  // =============================================================================
  // API / fetch errors
  // =============================================================================

  describe('fetch errors', () => {
    it('should propagate unexpected errors from fetchAndExtract', async () => {
      mockFetchAndExtract.mockRejectedValueOnce(new TypeError('Invalid URL'));

      try {
        await callTool({ urls: ['not-a-url'] });
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ToolError);
        expect((error as ToolError).data.errorCode).toBe('TOOL_NO_RESULTS');
      }
    });
  });
});
