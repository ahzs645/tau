import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

const { mockTurndown, mockGetText, mockDestroy } = vi.hoisted(() => ({
  mockTurndown: vi.fn(),
  mockGetText: vi.fn(),
  mockDestroy: vi.fn(),
}));

vi.mock('turndown', () => ({
  default: class TurndownService {
    public turndown = mockTurndown;
  },
}));

vi.mock('pdf-parse', () => ({
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export
  PDFParse: class {
    public getText = mockGetText;
    public destroy = mockDestroy;
  },
}));

// oxlint-disable-next-line eslint-plugin-import(first) -- must follow vi.mock calls
import { fetchAndExtract, maxContentLength, fetchTimeoutMs } from '#api/tools/utils/web-content-extractor.js';

// =============================================================================
// Helpers
// =============================================================================

type FetchResponseOptions = {
  body: string | ArrayBuffer;
  contentType: string;
  status?: number;
  statusText?: string;
};

function createFetchResponse({ body, contentType, status = 200, statusText = 'OK' }: FetchResponseOptions): Response {
  const buffer = typeof body === 'string' ? new TextEncoder().encode(body).buffer : body;
  return new Response(buffer, {
    status,
    statusText,
    headers: { 'content-type': contentType },
  });
}

describe('fetchAndExtract', () => {
  let fetchSpy: Mock<typeof globalThis.fetch>;

  beforeEach(() => {
    fetchSpy = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    mockTurndown.mockReset();
    mockGetText.mockReset();
    mockDestroy.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // =============================================================================
  // HTML routing (Finding 2, R4)
  // =============================================================================

  describe('HTML content', () => {
    it('should convert HTML response to markdown via Turndown', async () => {
      const html = '<h1>Hello World</h1><p>Some content</p>';
      fetchSpy.mockResolvedValueOnce(createFetchResponse({ body: html, contentType: 'text/html' }));
      mockTurndown.mockReturnValueOnce('# Hello World\n\nSome content');

      const result = await fetchAndExtract('https://example.com');

      expect(mockTurndown).toHaveBeenCalledWith(html);
      expect(result).toEqual({
        url: 'https://example.com',
        content: '# Hello World\n\nSome content',
        contentType: 'text/html',
        bytes: expect.any(Number) as number,
      });
    });

    it('should handle text/html with charset parameter', async () => {
      const html = '<p>UTF-8 content</p>';
      fetchSpy.mockResolvedValueOnce(createFetchResponse({ body: html, contentType: 'text/html; charset=utf-8' }));
      mockTurndown.mockReturnValueOnce('UTF-8 content');

      const result = await fetchAndExtract('https://example.com');

      expect(result.contentType).toBe('text/html');
      expect(mockTurndown).toHaveBeenCalledWith(html);
    });
  });

  // =============================================================================
  // PDF routing (Finding 1, R4)
  // =============================================================================

  describe('PDF content', () => {
    it('should extract text from PDF response via pdf-parse', async () => {
      const pdfBuffer = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer; // %PDF magic bytes
      fetchSpy.mockResolvedValueOnce(createFetchResponse({ body: pdfBuffer, contentType: 'application/pdf' }));
      mockGetText.mockResolvedValueOnce({ text: 'Extracted PDF text content' });

      const result = await fetchAndExtract('https://example.com/doc.pdf');

      expect(mockGetText).toHaveBeenCalled();
      expect(mockDestroy).toHaveBeenCalled();
      expect(result).toEqual({
        url: 'https://example.com/doc.pdf',
        content: 'Extracted PDF text content',
        contentType: 'application/pdf',
        bytes: 4,
      });
    });
  });

  // =============================================================================
  // Plain text passthrough
  // =============================================================================

  describe('plain text content', () => {
    it('should return raw text for text/plain content', async () => {
      const text = 'Plain text document content';
      fetchSpy.mockResolvedValueOnce(createFetchResponse({ body: text, contentType: 'text/plain' }));

      const result = await fetchAndExtract('https://example.com/readme.txt');

      expect(result).toEqual({
        url: 'https://example.com/readme.txt',
        content: text,
        contentType: 'text/plain',
        bytes: Buffer.byteLength(text),
      });
      expect(mockTurndown).not.toHaveBeenCalled();
      expect(mockGetText).not.toHaveBeenCalled();
    });
  });

  // =============================================================================
  // Markdown passthrough
  // =============================================================================

  describe('markdown content', () => {
    it('should return raw text for text/markdown content', async () => {
      const markdown = '# Heading\n\nSome **bold** text';
      fetchSpy.mockResolvedValueOnce(createFetchResponse({ body: markdown, contentType: 'text/markdown' }));

      const result = await fetchAndExtract('https://example.com/README.md');

      expect(result).toEqual({
        url: 'https://example.com/README.md',
        content: markdown,
        contentType: 'text/markdown',
        bytes: Buffer.byteLength(markdown),
      });
      expect(mockTurndown).not.toHaveBeenCalled();
    });
  });

  // =============================================================================
  // Unsupported content types
  // =============================================================================

  describe('unsupported content types', () => {
    it('should throw descriptive error for binary content types', async () => {
      fetchSpy.mockResolvedValueOnce(
        createFetchResponse({ body: 'binary data', contentType: 'application/octet-stream' }),
      );

      await expect(fetchAndExtract('https://example.com/file.bin')).rejects.toThrow(
        'Unsupported content type: application/octet-stream',
      );
    });

    it('should throw for image content types', async () => {
      fetchSpy.mockResolvedValueOnce(createFetchResponse({ body: 'image data', contentType: 'image/png' }));

      await expect(fetchAndExtract('https://example.com/photo.png')).rejects.toThrow(
        'Unsupported content type: image/png',
      );
    });
  });

  // =============================================================================
  // HTTP error handling
  // =============================================================================

  describe('HTTP errors', () => {
    it('should throw on non-2xx HTTP responses with status code', async () => {
      fetchSpy.mockResolvedValueOnce(
        createFetchResponse({ body: 'Not Found', contentType: 'text/html', status: 404, statusText: 'Not Found' }),
      );

      await expect(fetchAndExtract('https://example.com/missing')).rejects.toThrow('HTTP 404: Not Found');
    });

    it('should throw on server errors', async () => {
      fetchSpy.mockResolvedValueOnce(
        createFetchResponse({
          body: 'Internal Server Error',
          contentType: 'text/html',
          status: 500,
          statusText: 'Internal Server Error',
        }),
      );

      await expect(fetchAndExtract('https://example.com/error')).rejects.toThrow('HTTP 500: Internal Server Error');
    });

    it('should throw on network errors', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(fetchAndExtract('https://unreachable.example.com')).rejects.toThrow('fetch failed');
    });
  });

  // =============================================================================
  // Content size limit
  // =============================================================================

  describe('content size limit', () => {
    it('should throw when response exceeds maxContentLength', async () => {
      const oversizedBody = 'x'.repeat(maxContentLength + 1);
      fetchSpy.mockResolvedValueOnce(createFetchResponse({ body: oversizedBody, contentType: 'text/plain' }));

      await expect(fetchAndExtract('https://example.com/huge')).rejects.toThrow(/Content too large/);
    });
  });

  // =============================================================================
  // Fetch configuration
  // =============================================================================

  describe('fetch configuration', () => {
    it('should set User-Agent header', async () => {
      fetchSpy.mockResolvedValueOnce(createFetchResponse({ body: 'ok', contentType: 'text/plain' }));

      await fetchAndExtract('https://example.com');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.stringContaining('TauCAD') as string,
          }) as Record<string, string>,
        }),
      );
    });

    it('should set abort signal with timeout', async () => {
      fetchSpy.mockResolvedValueOnce(createFetchResponse({ body: 'ok', contentType: 'text/plain' }));

      await fetchAndExtract('https://example.com');

      const callArgs = fetchSpy.mock.calls[0]![1]!;
      expect(callArgs.signal).toBeInstanceOf(AbortSignal);
    });

    it('should export fetchTimeoutMs as 30 seconds', () => {
      expect(fetchTimeoutMs).toBe(30_000);
    });
  });
});
