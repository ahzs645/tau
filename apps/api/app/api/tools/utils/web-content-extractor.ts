import TurndownService from 'turndown';
import { PDFParse } from 'pdf-parse';

export const maxContentLength = 10 * 1024 * 1024; // 10 MB
export const fetchTimeoutMs = 30_000;
const userAgent = 'TauCAD-Agent/1.0';

export type ExtractedContent = {
  url: string;
  content: string;
  contentType: string;
  bytes: number;
};

const turndown = new TurndownService();

function parseMimeType(contentTypeHeader: string): string {
  return (contentTypeHeader.split(';')[0] ?? '').trim().toLowerCase();
}

async function extractPdfText(buffer: Uint8Array<ArrayBuffer>): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

async function extractByContentType(buffer: Uint8Array<ArrayBuffer>, mimeType: string): Promise<string> {
  if (mimeType === 'text/html') {
    return turndown.turndown(Buffer.from(buffer).toString('utf8'));
  }

  if (mimeType === 'application/pdf') {
    return extractPdfText(buffer);
  }

  if (mimeType.startsWith('text/')) {
    return Buffer.from(buffer).toString('utf8');
  }

  throw new Error(`Unsupported content type: ${mimeType}`);
}

export async function fetchAndExtract(url: string): Promise<ExtractedContent> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(fetchTimeoutMs),
    headers: {
      'User-Agent': userAgent,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- HTTP header
      Accept: 'text/html, text/markdown, application/pdf, text/*, */*',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const rawBuffer = new Uint8Array(arrayBuffer);

  if (rawBuffer.byteLength > maxContentLength) {
    throw new Error(`Content too large: ${rawBuffer.byteLength} bytes (limit: ${maxContentLength})`);
  }

  const contentTypeHeader = response.headers.get('content-type') ?? '';
  const mimeType = parseMimeType(contentTypeHeader);
  const content = await extractByContentType(rawBuffer, mimeType);

  return {
    url,
    content,
    contentType: mimeType,
    bytes: rawBuffer.byteLength,
  };
}
