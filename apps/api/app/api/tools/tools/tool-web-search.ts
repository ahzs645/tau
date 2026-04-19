import { Logger } from '@nestjs/common';
import { TavilySearch } from '@langchain/tavily';
import type { TavilyBaseSearchResponse } from '@langchain/tavily';
import { StructuredTool } from '@langchain/core/tools';
import type { CallbackManagerForToolRun } from '@langchain/core/callbacks/manager';
import { z } from 'zod';
import { toolName } from '@taucad/chat/constants';
import type { WebSearchOutput } from '@taucad/chat';

type CreateWebSearchToolOptions = {
  tavilyApiKey: string;
};

/**
 * Input schema for the web search tool.
 */
const webSearchInputSchema = z.object({
  query: z.string().describe('Search query to look up'),
});

/**
 * Custom web search tool that wraps TavilySearch and transforms its output.
 *
 * The raw Tavily response contains `{ results: [...], answer?: string, ... }`,
 * but we only need the `results` array for the UI. This wrapper uses TavilySearch
 * internally but returns only the parsed results array.
 */
class WebSearchTool extends StructuredTool {
  public override name = toolName.webSearch;
  public override description =
    'A search engine optimized for comprehensive, accurate, and trusted results. Useful for when you need to answer questions about current events. Input should be a search query.';

  public override schema = webSearchInputSchema;

  private readonly logger = new Logger(WebSearchTool.name);
  private readonly tavilyTool: TavilySearch;

  public constructor(tavilyTool: TavilySearch) {
    super();
    this.tavilyTool = tavilyTool;
  }

  protected override async _call(
    input: z.infer<typeof webSearchInputSchema>,
    _runManager?: CallbackManagerForToolRun,
  ): Promise<WebSearchOutput> {
    this.logger.debug(`Search query: "${input.query}"`);

    const rawResult = (await this.tavilyTool.invoke(input)) as TavilyBaseSearchResponse | { error: string };

    if ('error' in rawResult) {
      this.logger.warn(`Tavily API error for query "${input.query}": ${String(rawResult.error)}`);
      throw new Error(String(rawResult.error));
    }

    const { results } = rawResult;
    for (const r of results) {
      const preview = r.content.replaceAll(/\s+/g, ' ').trim().slice(0, 150);
      this.logger.debug(`Search result: "${r.title}" (${r.url}) — ${r.content.length} chars: "${preview}"`);
    }
    this.logger.debug(`Search complete for "${input.query}": ${results.length} results`);

    return results.map((result) => ({
      title: result.title,
      url: result.url,
      content: result.content,
    }));
  }
}

export const createWebSearchTool = ({ tavilyApiKey }: CreateWebSearchToolOptions): WebSearchTool => {
  const tavilyTool = new TavilySearch({
    maxResults: 5,
    topic: 'general',
    tavilyApiKey,
    // IncludeAnswer: false,
    // includeRawContent: false,
    // includeImages: false,
    // includeImageDescriptions: false,
    // searchDepth: "basic",
    // timeRange: "day",
    // includeDomains: [],
    // excludeDomains: [],
  });

  return new WebSearchTool(tavilyTool);
};
