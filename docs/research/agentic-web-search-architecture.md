---
title: 'Agentic Web Search Architecture'
description: 'Investigation into world-class agentic web search capable of handling all web resource types including PDFs, JS-rendered pages, and binary content'
status: draft
created: '2026-04-08'
updated: '2026-04-08'
category: architecture
related:
  - docs/research/tool-result-display-divergence.md
---

# Agentic Web Search Architecture

Investigation into building a world-class agentic web searching capability that reliably handles all types of web resources — not just static HTML — including PDFs, JavaScript-rendered pages, documentation sites, and binary content.

## Executive Summary

Our current web tools rely exclusively on Tavily for both search and content extraction. Tavily's Extract API is HTML-only — it has zero PDF parsing capability, limited JS rendering in basic mode, and fails silently on many documentation sites (e.g., Raspberry Pi). The reference architecture for production web-fetch tools follows a fundamentally different approach: direct HTTP fetch with content-type routing, Turndown for HTML→Markdown, binary persistence for PDFs, and a secondary model for summarization. This handles all content types and never delegates extraction to a third-party scraper. We recommend a hybrid architecture: keep Tavily for search (it excels at AI-ranked results), but replace Tavily Extract with a direct-fetch pipeline that handles content-type routing, PDF extraction, and intelligent fallback.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Architecture Blueprint](#architecture-blueprint)
- [Trade-offs](#trade-offs)
- [References](#references)

## Problem Statement

The `web_browser` tool (Tavily Extract) frequently returns "No content could be extracted" for legitimate, publicly accessible URLs. This manifests in two ways:

1. **Complete extraction failure** — all URLs fail, the tool throws `TOOL_NO_RESULTS`, and the agent loses access to the information
2. **Partial extraction failure** — some URLs succeed while others silently fail, producing incomplete research results

Observed failure patterns:

| URL Type                                             | Failure Mode                        | Root Cause                                        |
| ---------------------------------------------------- | ----------------------------------- | ------------------------------------------------- |
| JS-heavy documentation sites (e.g., raspberrypi.com) | Basic extraction returns empty      | Tavily basic mode does not execute JavaScript     |
| PDF URLs (e.g., datasheets, specs)                   | Extraction fails entirely           | Tavily has no PDF parsing capability              |
| Anti-scraping sites (e.g., some news sites)          | `failed_results` with generic error | Server-side bot detection blocks Tavily's scraper |
| Soft-404 pages                                       | Empty content returned as success   | Tavily does not detect soft-404 patterns          |

The auto-retry with `advanced` depth (implemented in prior work) mitigates JS-rendering failures but cannot address PDF or binary content — those are fundamentally outside Tavily Extract's scope.

## Methodology

1. **Reference architecture survey** — Studied production web-fetch and web-search tool architectures used by CLI-style coding agents to understand content-type routing, secondary-model summarization, and caching patterns
2. **Tavily API audit** — Exhaustive review of Tavily Extract, Search, and Crawl documentation including changelog through March 2026
3. **Alternative evaluation** — Comparison of Firecrawl, Jina Reader, and direct-fetch approaches for content extraction
4. **Gap analysis** — Comparison of our current Tavily-only pipeline against the architectures above

## Findings

### Finding 1: Tavily Extract is HTML-Only by Design

Tavily Extract is documented exclusively as a "web scraping solution" for web page content. There is no PDF support, no OCR, no document parsing.

| Capability        | Tavily Extract   | Notes                               |
| ----------------- | ---------------- | ----------------------------------- |
| Static HTML       | Yes (basic)      | Fast, 10s timeout                   |
| JS-rendered pages | Yes (advanced)   | Slower, 30s timeout, 2x cost        |
| PDF files         | No               | URLs fail or return garbled content |
| Office documents  | No               | Not supported                       |
| Binary content    | No               | Not supported                       |
| Content format    | Markdown or text | Both assume HTML source             |

The `format: "markdown"` option converts _from HTML_ to markdown — it does not provide markdown extraction from arbitrary document types.

### Finding 2: The Reference Web-Fetch Architecture Uses Direct HTTP Fetch with Content-Type Routing

The reference architecture for production web-fetch tools does not delegate to Tavily, Firecrawl, or any third-party extraction API. Instead, it implements a self-contained pipeline:

```
URL → HTTP GET → Content-Type inspection → Route
  ├── text/html → Turndown (HTML→Markdown) → secondary-model summarization
  ├── text/* → Raw UTF-8 string → secondary-model summarization
  └── binary (application/pdf, etc.) → Persist to disk + UTF-8 decode → secondary-model summarization
```

Key architectural decisions:

1. **Fetch is local** — Direct HTTP client with custom User-Agent, 60s timeout, 10MB body cap
2. **Content-type routing** — Binary vs text vs HTML determined by `Content-Type` header, not by attempting to parse everything as HTML
3. **Binary persistence** — PDFs, images, and other binary content are saved to disk with MIME-derived extensions (`.pdf`, `.xlsx`, etc.) so the model can inspect the raw file later
4. **Dual delivery for PDFs** — The UTF-8 decoded string (which contains enough ASCII structure from PDF text streams — `/Title`, text streams) is passed through summarization, AND the raw binary is persisted. The decoded string carries enough ASCII structure that a small/cheap model can extract a useful summary even without true PDF parsing
5. **Secondary model** — Content is processed through a small/cheap model with the user's prompt, producing a focused summary rather than returning raw page content
6. **15-min LRU cache** — 50MB URL cache with TTL prevents redundant fetches
7. **Redirect safety** — Same-host redirects followed automatically; cross-host redirects surfaced to the model for explicit re-invocation

### Finding 3: Server-Side Search Tools Are Not Available to Third-Party API Consumers

The strongest reference implementations for web search are first-party server-side tools (e.g., Anthropic's `web_search_20250305` server tool) that execute search queries server-side within the model provider's API. The search index and execution are entirely on the provider's infrastructure. This is not available to third-party API consumers.

For search, Tavily remains our best option. Tavily Search is purpose-built for AI-ranked results and provides good content snippets. The search component is not the problem — the extraction component is.

### Finding 4: Firecrawl is the Strongest Extraction Alternative

Firecrawl positions itself as extraction-first (vs Tavily's search-first):

| Feature               | Firecrawl                                | Tavily Extract            |
| --------------------- | ---------------------------------------- | ------------------------- |
| PDF extraction        | PDF Parser v2 with Auto/Fast/OCR modes   | None                      |
| JS rendering          | Pre-warmed Chromium                      | Advanced mode only        |
| Output formats        | Markdown, HTML, JSON, screenshots, links | Markdown, text            |
| Structured extraction | LLM-based JSON extraction                | Chunk reranking only      |
| Anti-bot handling     | Enhanced proxy, stealth mode             | Limited                   |
| Pricing               | $16/mo (3,000 credits)                   | Included with Tavily plan |
| LangChain integration | `@langchain/community` loader            | `@langchain/tavily`       |

PDF Parser v2 (Rust-based, released Feb 2026) offers three modes:

- **Fast** — Text extraction only (fastest, cheapest)
- **Auto** — Text extraction with automatic OCR fallback for scanned pages
- **OCR** — Forced OCR for fully scanned/image-based PDFs

However, adding Firecrawl introduces another third-party dependency, another API key, and another failure mode.

### Finding 5: Jina Reader is a Lightweight Fallback Option

Jina's Reader API (`r.jina.ai`) converts URLs to markdown by simply prepending the URL:

```
GET https://r.jina.ai/https://example.com
```

- Handles PDFs (including base64-encoded input)
- Free without API key at 20 RPM
- 500 RPM with free API key (1M free tokens)
- Uses ReaderLM-v2 (1.5B params) for intelligent conversion
- Supports multiple output formats: markdown, HTML, text, JSON

The simplicity of the API makes it attractive as a fallback, but the rate limits and third-party dependency are concerns.

### Finding 6: The Direct-Fetch Architecture is More Resilient

Comparing failure modes across approaches:

| Failure Scenario | Tavily Extract                       | Direct HTTP + Turndown      | Firecrawl              |
| ---------------- | ------------------------------------ | --------------------------- | ---------------------- |
| PDF URL          | Fails                                | UTF-8 decode + persist      | PDF Parser v2          |
| JS-heavy page    | Fails (basic) or succeeds (advanced) | Fails (no JS)               | Succeeds (Chromium)    |
| Anti-scraping    | Fails                                | May fail (no stealth)       | Better (stealth proxy) |
| Rate limited     | API rate limit                       | No rate limit (self-hosted) | API rate limit         |
| Service outage   | Total failure                        | No dependency               | Total failure          |
| Binary content   | Fails                                | Persists + decodes          | Depends on type        |
| Cost at scale    | Per-request credits                  | Zero marginal cost          | Per-request credits    |

The direct-fetch approach is the only one that eliminates third-party extraction dependencies entirely. The reference architecture demonstrates this is production-viable at scale.

### Finding 7: Our Search Results Lack Raw Content

Our `web_search` tool uses `TavilySearch` with default configuration, which returns only short content snippets (NLP summaries) per result. Tavily Search supports `include_raw_content: true` (or `"markdown"`) which returns the full cleaned/parsed page content inline with search results — effectively combining search + extract in one call.

Current config:

```typescript
new TavilySearch({
  maxResults: 5,
  topic: 'general',
  tavilyApiKey,
});
```

Missing options that could improve result quality:

- `includeRawContent: true` — Get full page content with search results
- `searchDepth: 'advanced'` — Deeper search with semantic chunking
- `chunksPerSource: 3` — Multiple relevant chunks per source (advanced only)

## Recommendations

| #   | Action                                                 | Priority | Effort | Impact |
| --- | ------------------------------------------------------ | -------- | ------ | ------ |
| R1  | Implement direct-fetch pipeline for `web_browser` tool | P0       | Medium | High   |
| R2  | Add Jina Reader as extraction fallback                 | P1       | Low    | Medium |
| R3  | Enhance `web_search` with `includeRawContent`          | P1       | Low    | Medium |
| R4  | Add content-type routing with PDF support              | P0       | Medium | High   |
| R5  | Add LRU cache for fetched content                      | P2       | Low    | Low    |
| R6  | Evaluate Firecrawl for JS-heavy pages                  | P2       | Medium | Medium |

### R1: Direct-Fetch Pipeline (P0)

Replace Tavily Extract with a direct HTTP fetch pipeline (matching the reference architecture in F2). This eliminates the third-party extraction dependency and enables content-type routing.

The pipeline fetches the URL directly, inspects `Content-Type`, and routes through the appropriate conversion:

- `text/html` → Turndown → Markdown
- `text/markdown`, `text/plain` → Raw content
- `application/pdf` → PDF text extraction (via `pdf-parse` or `pdfjs-dist`)
- Other binary → Error with descriptive message

This is the highest-impact change: it fixes the root cause (Tavily Extract's HTML-only limitation) rather than working around it.

### R2: Jina Reader Fallback (P1)

When direct fetch + Turndown produces poor results (e.g., JS-heavy pages where the HTML is mostly empty `<div id="app">`), fall back to Jina Reader:

```
GET https://r.jina.ai/{url}
```

Jina handles JS rendering and returns clean markdown. The 20 RPM free tier is sufficient for occasional fallback use. This provides the JS-rendering capability without adding a full Chromium dependency.

Detection heuristic: if the extracted markdown from direct fetch is below a content threshold (e.g., <200 chars for a non-redirect response), the page likely requires JS rendering — trigger Jina fallback.

### R3: Enhanced Search Results (P1)

Configure `TavilySearch` with richer result content:

```typescript
new TavilySearch({
  maxResults: 5,
  topic: 'general',
  tavilyApiKey,
  includeRawContent: 'markdown',
  searchDepth: 'advanced',
});
```

This provides full page content inline with search results, reducing the need for separate extraction calls and giving the agent more context to work with upfront.

### R4: Content-Type Routing with PDF Support (P0)

Implement content-type inspection and routing for the direct-fetch pipeline:

```typescript
const contentType = response.headers['content-type'] ?? '';
const mimeType = contentType.split(';')[0].trim().toLowerCase();

if (mimeType === 'text/html') {
  return turndownService.turndown(body);
} else if (mimeType === 'application/pdf') {
  return extractPdfText(buffer);
} else if (mimeType.startsWith('text/')) {
  return body;
} else {
  return `[Binary content: ${mimeType}, ${bytes} bytes — not extractable as text]`;
}
```

For PDF extraction, `pdf-parse` (wrapper around `pdfjs-dist`) provides server-side text extraction with zero external API dependency:

```typescript
import pdfParse from 'pdf-parse';
const data = await pdfParse(buffer);
return data.text; // Extracted text content
```

### R5: Content Cache (P2)

Add an LRU cache for fetched content, matching the reference pattern in F2:

- 50MB size limit with byte-based eviction
- 15-minute TTL
- Keyed on original URL (not redirected URL)
- Prevents redundant fetches within a conversation

### R6: Firecrawl Evaluation (P2)

For JS-heavy pages where both direct fetch and Jina Reader produce inadequate results, Firecrawl's pre-warmed Chromium and stealth proxy provide the highest extraction success rate. However, this adds cost and dependency complexity. Evaluate only if R1+R2 leave a meaningful gap in extraction success.

## Architecture Blueprint

### Current Architecture (Tavily-Only)

```
Agent
├── web_search → Tavily Search API → { title, url, snippet }
└── web_browser → Tavily Extract API → { url, raw_content }
                   └── Fails on: PDF, binary, many JS sites
```

### Proposed Architecture (Hybrid Direct-Fetch)

```
Agent
├── web_search → Tavily Search API (enhanced)
│                 └── includeRawContent: 'markdown'
│                 └── searchDepth: 'advanced'
│
└── web_browser → Direct HTTP Fetch
                   ├── Content-Type: text/html
                   │    └── Turndown → Markdown
                   │    └── If content < threshold → Jina Reader fallback
                   │
                   ├── Content-Type: application/pdf
                   │    └── pdf-parse → Text extraction
                   │
                   ├── Content-Type: text/*
                   │    └── Raw content (already text)
                   │
                   └── Content-Type: other
                        └── Descriptive error message
```

### Data Flow for a Typical Research Query

```
User: "Find Raspberry Pi 5 enclosure projects"
  │
  ├─ web_search("raspberry pi 5 enclosure 3D printable")
  │   └─ Returns 5 results with full markdown content (R3)
  │   └─ Agent identifies promising URLs
  │
  ├─ web_browser(["https://www.raspberrypi.com/documentation/..."])
  │   └─ Direct fetch → text/html → Turndown → markdown ✓
  │   └─ If thin content → Jina fallback → markdown ✓
  │
  ├─ web_browser(["https://example.com/enclosure-specs.pdf"])
  │   └─ Direct fetch → application/pdf → pdf-parse → text ✓
  │
  └─ Agent synthesizes results with citations
```

## Trade-offs

| Approach                 | Pros                                                                        | Cons                                               |
| ------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------- |
| **Direct fetch (R1)**    | Zero third-party dependency, handles all content types, no per-request cost | No JS rendering, no anti-bot stealth               |
| **Jina fallback (R2)**   | Handles JS-heavy pages, simple API, generous free tier                      | Third-party dependency, 20 RPM without key         |
| **Enhanced search (R3)** | Richer context upfront, fewer extraction calls needed                       | Higher Tavily cost (advanced = 2x credits)         |
| **Firecrawl (R6)**       | Best extraction quality, PDF v2, stealth proxy                              | Additional API key, $16+/mo, another dependency    |
| **Keep Tavily Extract**  | No migration effort, existing tests                                         | Cannot handle PDF, frequent failures on docs sites |

### Why Not Just Switch to Firecrawl Entirely?

Firecrawl could replace both Tavily Search and Extract, but:

1. **Search quality** — Tavily's AI-ranked search results are purpose-built for agent workflows; Firecrawl's search is newer and less proven
2. **Cost** — Firecrawl charges per scrape, while direct fetch is free at the marginal level
3. **Dependency** — Trading one third-party dependency for another does not improve resilience
4. **Scope** — Most extraction failures are solvable with direct fetch + content-type routing — Firecrawl's Chromium is overkill for the common case

### Why Not Use a Headless Browser?

Running Chromium server-side (Playwright/Puppeteer) would handle JS rendering natively, but:

1. **Resource cost** — Each browser instance consumes 200-500MB RAM
2. **Latency** — Browser startup + page load adds 3-10s per request
3. **Complexity** — Browser lifecycle management, pool sizing, crash recovery
4. **Diminishing returns** — Most documentation sites serve pre-rendered HTML; JS rendering is needed for SPAs, not general documentation

The Jina Reader fallback provides JS rendering without the operational burden.

## Code Examples

### Direct HTTP Fetch with Content-Type Routing

```typescript
import TurndownService from 'turndown';
import pdfParse from 'pdf-parse';

const turndown = new TurndownService();
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024; // 10MB
const FETCH_TIMEOUT_MS = 30_000;
const THIN_CONTENT_THRESHOLD = 200;

type FetchResult = {
  content: string;
  contentType: string;
  bytes: number;
  url: string;
};

async function fetchAndExtract(url: string): Promise<FetchResult> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'TauCAD-Agent/1.0' },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const mimeType = contentType.split(';')[0].trim().toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length > MAX_CONTENT_LENGTH) {
    throw new Error(`Content too large: ${buffer.length} bytes`);
  }

  if (mimeType === 'application/pdf') {
    const pdf = await pdfParse(buffer);
    return { content: pdf.text, contentType: mimeType, bytes: buffer.length, url };
  }

  if (mimeType === 'text/html') {
    const html = buffer.toString('utf-8');
    const markdown = turndown.turndown(html);

    if (markdown.length < THIN_CONTENT_THRESHOLD) {
      return fetchViaJina(url);
    }

    return { content: markdown, contentType: mimeType, bytes: buffer.length, url };
  }

  if (mimeType.startsWith('text/')) {
    return { content: buffer.toString('utf-8'), contentType: mimeType, bytes: buffer.length, url };
  }

  throw new Error(`Unsupported content type: ${mimeType}`);
}

async function fetchViaJina(url: string): Promise<FetchResult> {
  const response = await fetch(`https://r.jina.ai/${url}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: 'text/markdown' },
  });

  const content = await response.text();
  return { content, contentType: 'text/markdown', bytes: Buffer.byteLength(content), url };
}
```

## References

- [Tavily Extract API Reference](https://docs.tavily.com/documentation/api-reference/endpoint/extract)
- [Tavily Search API Reference](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [Firecrawl PDF Parser v2](https://www.firecrawl.dev/blog/pdf-parser-v2)
- [Firecrawl vs Tavily Comparison](https://www.firecrawl.dev/compare/firecrawl-vs-tavily)
- [Jina Reader API](https://r.jina.ai/docs)
- [Turndown HTML-to-Markdown](https://github.com/domchristie/turndown)
- [pdf-parse npm package](https://www.npmjs.com/package/pdf-parse)
- [Agentic Research Agent Design Patterns](https://www.marktechpost.com/2026/02/20/how-to-design-a-swiss-army-knife-research-agent-with-tool-using-ai-web-search-pdf-analysis-vision-and-automated-reporting/)
