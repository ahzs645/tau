import { Logger } from '@nestjs/common';
import { StructuredTool } from '@langchain/core/tools';
import type { CallbackManagerForToolRun } from '@langchain/core/callbacks/manager';
import { z } from 'zod';
import { toolName } from '@taucad/chat/constants';
import { ToolError } from '@taucad/chat/utils';
import type { WebBrowserOutput } from '@taucad/chat';
import { fetchAndExtract } from '#api/tools/utils/web-content-extractor.js';

const webBrowserInputSchema = z.object({
  urls: z.array(z.string()).min(1).max(5).describe('One or more URLs to extract content from (max 5)'),
  query: z.string().optional().describe('Optional context describing what information to look for'),
});

/**
 * Web browser tool that fetches and extracts content from URLs directly.
 *
 * Uses a direct HTTP fetch pipeline with content-type routing:
 * - HTML pages are converted to markdown via Turndown
 * - PDF documents are parsed to text via pdf-parse
 * - Plain text / markdown is returned as-is
 *
 * Each URL is fetched independently; partial failures are reported per-URL
 * while successful extractions are still returned.
 */
class WebBrowserTool extends StructuredTool {
  public override name = toolName.webBrowser;
  public override description =
    'Extract content from one or more web pages. Accepts an array of URLs (max 5) to batch-extract in a single call. Supports HTML pages, PDF documents, and plain text. Use after web_search to read full page content from promising results.';

  public override schema = webBrowserInputSchema;

  private readonly logger = new Logger(WebBrowserTool.name);

  protected override async _call(
    input: z.infer<typeof webBrowserInputSchema>,
    _runManager?: CallbackManagerForToolRun,
  ): Promise<WebBrowserOutput> {
    this.logger.debug(`Extract request: urls=[${input.urls.join(', ')}]`);

    const settled = await Promise.allSettled(input.urls.map(async (url) => fetchAndExtract(url)));

    const output: WebBrowserOutput = [];
    let successCount = 0;
    let failCount = 0;

    for (const [i, result] of settled.entries()) {
      const url = input.urls[i]!;

      if (result.status === 'fulfilled') {
        successCount++;
        const { contentType, bytes, content } = result.value;
        const preview = content.replaceAll(/\s+/g, ' ').trim().slice(0, 200);
        this.logger.debug(
          `Extract success: ${result.value.url} — ${contentType}, ${bytes} bytes, ${content.length} chars text. Preview: "${preview}"`,
        );
        output.push({ url: result.value.url, content });
      } else {
        failCount++;
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.logger.warn(`Extract failed: ${url} — ${message}`);
        output.push({ url, content: `[Extraction failed] ${message}. Try a different source via web_search.` });
      }
    }

    if (successCount === 0) {
      this.logger.warn(`All extraction attempts failed for urls=[${input.urls.join(', ')}]`);
      throw new ToolError({
        errorCode: 'TOOL_NO_RESULTS',
        message: 'Could not extract content from the requested URLs. Try different URLs via web_search.',
        toolName: this.name,
        toolCallId: _runManager?.runId ?? 'unknown',
      });
    }

    this.logger.debug(`Returning ${output.length} results (${successCount} succeeded, ${failCount} failed)`);

    return output;
  }
}

export const createWebBrowserTool = (): WebBrowserTool => new WebBrowserTool();
