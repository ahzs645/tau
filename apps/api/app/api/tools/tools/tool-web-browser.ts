import { TavilyExtract } from '@langchain/tavily';
import type { TavilyExtractResponse } from '@langchain/tavily';
import { StructuredTool } from '@langchain/core/tools';
import type { CallbackManagerForToolRun } from '@langchain/core/callbacks/manager';
import { z } from 'zod';
import { toolName } from '@taucad/chat/constants';
import type { WebBrowserOutput } from '@taucad/chat';

type CreateWebBrowserToolOptions = {
  tavilyApiKey: string;
};

/**
 * Input schema for the web browser tool.
 */
const webBrowserInputSchema = z.object({
  urls: z.array(z.string()).min(1).max(5).describe('One or more URLs to extract content from (max 5)'),
  query: z.string().optional().describe('Optional query to rerank extracted chunks by relevance'),
});

/**
 * Custom web browser tool that wraps TavilyExtract and transforms its output.
 *
 * The raw Tavily response contains `{ results: [...], failed_results: [...], ... }`,
 * but we only need the `results` array mapped to `{ url, content }`. This wrapper
 * uses TavilyExtract internally but returns only the transformed results array.
 */
class WebBrowserTool extends StructuredTool {
  public override name = toolName.webBrowser;
  public override description =
    'Extract content from one or more web pages. Accepts an array of URLs (max 5) to batch-extract in a single call. Use after web_search to read full page content from promising results. Optionally pass a query to get only relevant chunks.';

  public override schema = webBrowserInputSchema;

  private readonly tavilyTool: TavilyExtract;

  public constructor(tavilyTool: TavilyExtract) {
    super();
    this.tavilyTool = tavilyTool;
  }

  protected override async _call(
    input: z.infer<typeof webBrowserInputSchema>,
    _runManager?: CallbackManagerForToolRun,
  ): Promise<WebBrowserOutput> {
    const rawResult = (await this.tavilyTool.invoke({
      urls: input.urls,
      ...(input.query ? { query: input.query } : {}),
    })) as TavilyExtractResponse | { error: string };

    // Handle error responses
    if ('error' in rawResult) {
      throw new Error(String(rawResult.error));
    }

    // Extract and transform only the results array
    return rawResult.results.map((result) => ({
      url: result.url,
      content: result.raw_content,
    }));
  }
}

export const createWebBrowserTool = ({ tavilyApiKey }: CreateWebBrowserToolOptions): WebBrowserTool => {
  const tavilyTool = new TavilyExtract({
    extractDepth: 'basic',
    includeImages: false,
    format: 'markdown',
    tavilyApiKey,
  });

  return new WebBrowserTool(tavilyTool);
};
