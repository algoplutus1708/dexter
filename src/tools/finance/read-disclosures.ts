import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { callLlm, callLlmWithMessages } from '../../model/llm.js';
import { formatToolResult, parseSearchResults } from '../types.js';
import { getCurrentDate } from '../../agent/prompts.js';
import { webFetchTool } from '../fetch/web-fetch.js';
import { browserTool } from '../browser/browser.js';
import { exaSearch, perplexitySearch, tavilySearch } from '../search/index.js';
import { extractTextContent } from '../../utils/ai-message.js';
import { resolveProvider } from '../../providers.js';
import {
  buildCanonicalDisclosureUrls,
  buildIndiaDisclosureQueries,
  INDIA_DISCLOSURE_DOMAINS,
  INDIA_DISCLOSURE_TYPES,
  isProtectedIndianDisclosureDomain,
  type IndiaDisclosureType,
} from './india-market.js';

const PDF_OCR_SYSTEM_PROMPT = 'You are a financial data extraction engine. Read this scanned Indian corporate disclosure. Extract all tabular financial data, board meeting outcomes, and text exactly as presented. Return as clean Markdown.';
const PDF_OCR_USER_PROMPT = 'Extract this Indian corporate disclosure PDF into clean Markdown.';
const GOOGLE_PDF_OCR_MODEL = 'gemini-1.5-pro';
const OPENAI_PDF_OCR_MODEL = 'gpt-4o';

export const READ_DISCLOSURES_DESCRIPTION = `
Intelligent meta-tool for reading Indian listed-company disclosures. Takes a natural language query and searches official NSE, BSE, and SEBI sources for the most relevant filings, announcements, and investor documents.

## When to Use

- Reading quarterly or annual financial results for Indian listed companies
- Finding annual reports, shareholding patterns, investor presentations, board-meeting outcomes, or corporate announcements
- Reviewing promoter or insider disclosures and other exchange/SEBI-regulated company disclosures
- Comparing disclosures across multiple periods for an Indian listed company

## When NOT to Use

- Structured financial statements or ratios (use get_financials)
- Price/volume/news questions (use get_market_data)
- Open-web research unrelated to official company disclosures (use web_search)

## Usage Notes

- Call ONCE with the complete natural language query
- Prioritizes official sources: NSE India, BSE India, and SEBI
- Searches for India-specific disclosure types like annual reports, quarterly results, shareholding patterns, and corporate announcements
- If a search provider is unavailable, returns canonical official page URLs you can inspect manually
`.trim();

const DisclosureTypeSchema = z.enum(INDIA_DISCLOSURE_TYPES);

const DisclosurePlanSchema = z.object({
  company_or_symbol: z.string().describe('Indian company name or trading symbol to search for'),
  disclosure_types: z.array(DisclosureTypeSchema).min(1).max(3).describe('Official disclosure categories needed to answer the query'),
  exchange_hint: z.enum(['NSE', 'BSE', 'AUTO']).default('AUTO').describe('Preferred exchange for discovery'),
  fetch_limit: z.number().int().min(1).max(3).default(2).describe('How many source pages to fetch for readable content'),
});

type DisclosurePlan = z.infer<typeof DisclosurePlanSchema>;

type SearchHit = {
  title?: string;
  url: string;
  snippet?: string;
};

type FetchedDisclosure = {
  url: string;
  title?: string;
  snippet?: string;
  content: unknown;
  error: string | null;
  fetchMode?: 'web_fetch' | 'browser' | 'pdf';
};

type PdfOcrMessageContent = Array<Record<string, unknown> & { type: string }>;

function getOfficialSearchTool() {
  if (process.env.EXASEARCH_API_KEY) return exaSearch;
  if (process.env.PERPLEXITY_API_KEY) return perplexitySearch;
  if (process.env.TAVILY_API_KEY) return tavilySearch;
  return null;
}

function buildPlanPrompt(): string {
  return `You are an Indian-market disclosure planning assistant.
Current date: ${getCurrentDate()}

Given a user query about Indian company disclosures, return structured plan fields:
- company_or_symbol
- disclosure_types
- exchange_hint
- fetch_limit

## Guidelines

1. Focus on Indian listed-company disclosure workflows, not SEC filing types
2. Map user intent to these disclosure types:
   - quarterly or annual results → financial-results
   - annual report → annual-report
   - promoter holding or public shareholding → shareholding-pattern
   - exchange filing or company update → corporate-announcement
   - board meeting notice/outcome → board-meeting
   - earnings deck or IR deck → investor-presentation
   - call notes or transcript → concall-transcript
   - promoter/management dealing disclosures → insider-disclosure
3. Use exchange_hint:
   - NSE if user mentions NSE or omits exchange
   - BSE if user explicitly mentions BSE
   - AUTO if unclear
4. Keep fetch_limit small: default 2, max 3

Return only the structured output fields.`;
}

function extractSearchHits(parsed: unknown): SearchHit[] {
  if (Array.isArray(parsed)) {
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        title: typeof item.title === 'string' ? item.title : undefined,
        url: typeof item.url === 'string' ? item.url : '',
        snippet: typeof item.snippet === 'string'
          ? item.snippet
          : typeof item.content === 'string'
            ? item.content
            : undefined,
      }))
      .filter((item) => item.url);
  }

  if (parsed && typeof parsed === 'object' && 'results' in parsed) {
    const results = (parsed as { results?: unknown[] }).results;
    if (Array.isArray(results)) {
      return extractSearchHits(results);
    }
  }

  if (parsed && typeof parsed === 'object' && 'answer' in parsed && 'results' in parsed) {
    const results = (parsed as { results?: unknown[] }).results;
    if (Array.isArray(results)) {
      return extractSearchHits(results);
    }
  }

  return [];
}

function isOfficialDisclosureUrl(url: string): boolean {
  return INDIA_DISCLOSURE_DOMAINS.some((domain) => url.includes(domain));
}

function looksLikePdfUrl(url: string): boolean {
  return url.toLowerCase().includes('.pdf');
}

function browserLikeHeaders(url: string): HeadersInit {
  const origin = new URL(url).origin;
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7',
    'Accept-Language': 'en-IN,en;q=0.9',
    Referer: origin,
  };
}

function getPdfFilename(url: string): string {
  const path = new URL(url).pathname;
  const filename = decodeURIComponent(path.split('/').pop() ?? '').trim();
  return filename.toLowerCase().endsWith('.pdf') ? filename : 'disclosure.pdf';
}

function supportsPdfOcr(model: string): boolean {
  const provider = resolveProvider(model).id;
  return provider === 'google' || provider === 'openai';
}

function selectPdfOcrModel(activeModel: string): string {
  if (supportsPdfOcr(activeModel)) {
    return activeModel;
  }

  if (process.env.GOOGLE_API_KEY) return GOOGLE_PDF_OCR_MODEL;
  if (process.env.OPENAI_API_KEY) return OPENAI_PDF_OCR_MODEL;
  throw new Error('No multimodal PDF OCR model is configured. Use an OpenAI/Gemini model, or set GOOGLE_API_KEY / OPENAI_API_KEY.');
}

function buildPdfOcrMessageContent(pdfBase64: string, model: string, filename: string): PdfOcrMessageContent {
  const ocrModel = selectPdfOcrModel(model);
  const provider = resolveProvider(ocrModel).id;

  if (provider === 'google') {
    return [
      {
        type: 'application/pdf',
        data: pdfBase64,
      },
      {
        type: 'text',
        text: PDF_OCR_USER_PROMPT,
      },
    ];
  }

  return [
    {
      type: 'text',
      text: PDF_OCR_USER_PROMPT,
    },
    {
      type: 'file',
      mimeType: 'application/pdf',
      data: pdfBase64,
      metadata: { filename },
    },
  ];
}

async function extractPdfWithMultimodalOcr(pdfBase64: string, url: string, model: string): Promise<{ text: string; model: string }> {
  const ocrModel = selectPdfOcrModel(model);
  const { response } = await callLlmWithMessages([
    new SystemMessage(PDF_OCR_SYSTEM_PROMPT),
    new HumanMessage({
      content: buildPdfOcrMessageContent(pdfBase64, ocrModel, getPdfFilename(url)),
    } as ConstructorParameters<typeof HumanMessage>[0]),
  ], {
    model: ocrModel,
  });

  const text = extractTextContent(response).trim();
  if (!text) {
    throw new Error(`Multimodal OCR returned no text using model ${ocrModel}`);
  }

  return { text, model: ocrModel };
}

async function fetchPdfDisclosure(url: string, model: string, _maxChars = 6000): Promise<{ content: unknown; fetchMode: 'pdf' }> {
  const response = await fetch(url, { headers: browserLikeHeaders(url) });
  if (!response.ok) {
    throw new Error(`PDF fetch failed: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/pdf') && !looksLikePdfUrl(url)) {
    throw new Error(`Expected PDF but received ${contentType || 'unknown content-type'}`);
  }

  const buffer = await response.arrayBuffer();
  const pdfBase64 = Buffer.from(buffer).toString('base64');

  try {
    const extracted = await extractPdfWithMultimodalOcr(pdfBase64, url, model);
    return {
      fetchMode: 'pdf',
      content: {
        url,
        title: null,
        text: extracted.text,
        truncated: false,
        pages: null,
        extractor: 'multimodal-ocr',
        model: extracted.model,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      message.toLowerCase().includes('password') || message.toLowerCase().includes('encrypted')
        ? 'PDF is encrypted or password-protected'
        : message,
    );
  }
}

async function fetchProtectedDisclosureInBrowser(url: string, maxChars = 6000): Promise<{ content: unknown; fetchMode: 'browser' }> {
  try {
    const navigateRaw = await browserTool.invoke({ action: 'open', url });
    const navigateParsed = typeof navigateRaw === 'string' ? JSON.parse(navigateRaw) : navigateRaw;
    if (navigateParsed?.data?.error) {
      throw new Error(String(navigateParsed.data.error));
    }

    const readRaw = await browserTool.invoke({ action: 'read' });
    const readParsed = typeof readRaw === 'string' ? JSON.parse(readRaw) : readRaw;
    const content = readParsed?.data ?? readParsed;
    const text = typeof content?.text === 'string' ? content.text.slice(0, maxChars) : '';

    return {
      fetchMode: 'browser',
      content: {
        ...content,
        text,
        truncated: typeof content?.text === 'string' ? content.text.length > maxChars : Boolean(content?.truncated),
      },
    };
  } finally {
    await browserTool.invoke({ action: 'close' }).catch(() => undefined);
  }
}

async function fetchDisclosureContent(url: string, model: string, maxChars = 6000): Promise<{ content: unknown; fetchMode: 'web_fetch' | 'browser' | 'pdf' }> {
  if (looksLikePdfUrl(url)) {
    return fetchPdfDisclosure(url, model, maxChars);
  }

  const head = await fetch(url, {
    method: 'HEAD',
    redirect: 'follow',
    headers: browserLikeHeaders(url),
  }).catch(() => null);

  const contentType = head?.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/pdf')) {
    return fetchPdfDisclosure(url, model, maxChars);
  }

  if (isProtectedIndianDisclosureDomain(url)) {
    return fetchProtectedDisclosureInBrowser(url, maxChars);
  }

  const raw = await webFetchTool.invoke({
    url,
    extractMode: 'text',
    maxChars,
  });
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return { fetchMode: 'web_fetch', content: parsed?.data ?? parsed };
}

export function createReadDisclosures(model: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'read_disclosures',
    description: READ_DISCLOSURES_DESCRIPTION,
    schema: z.object({
      query: z.string().describe('Natural language query about Indian company disclosures'),
    }),
    func: async (input, _runManager, config?: RunnableConfig) => {
      const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;

      onProgress?.('Planning disclosure search...');
      let plan: DisclosurePlan;
      try {
        const { response } = await callLlm(input.query, {
          model,
          systemPrompt: buildPlanPrompt(),
          outputSchema: DisclosurePlanSchema,
        });
        plan = DisclosurePlanSchema.parse(response);
      } catch (error) {
        return formatToolResult({
          error: 'Failed to build disclosure search plan',
          details: error instanceof Error ? error.message : String(error),
        }, []);
      }

      const searchTool = getOfficialSearchTool();
      const canonicalUrls = buildCanonicalDisclosureUrls(plan.company_or_symbol);
      const sourceUrls = [...canonicalUrls];

      if (!searchTool) {
        return formatToolResult({
          plan,
          officialPages: canonicalUrls,
          note: 'No web search provider is configured. Add EXASEARCH_API_KEY, PERPLEXITY_API_KEY, or TAVILY_API_KEY to enable live official-source disclosure discovery.',
        }, sourceUrls);
      }

      const queries = buildIndiaDisclosureQueries({
        companyOrSymbol: plan.company_or_symbol,
        disclosureTypes: plan.disclosure_types as IndiaDisclosureType[],
      });

      onProgress?.('Searching official NSE/BSE/SEBI sources...');
      const searchResults = await Promise.all(
        queries.map(async (query) => {
          try {
            const raw = await searchTool.invoke({ query });
            const { parsed, urls } = parseSearchResults(raw);
            return {
              query,
              hits: extractSearchHits(parsed).filter((hit) => isOfficialDisclosureUrl(hit.url)),
              urls,
              error: null,
            };
          } catch (error) {
            return {
              query,
              hits: [] as SearchHit[],
              urls: [] as string[],
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );

      const allHits = searchResults.flatMap((result) => result.hits);
      const dedupedHits = Array.from(new Map(allHits.map((hit) => [hit.url, hit])).values());
      const topHits = dedupedHits.slice(0, plan.fetch_limit);

      const fetchResults = await Promise.all(
        topHits.map(async (hit) => {
          try {
            const fetched = await fetchDisclosureContent(hit.url, model, 6000);
            return {
              url: hit.url,
              title: hit.title,
              snippet: hit.snippet,
              content: fetched.content,
              fetchMode: fetched.fetchMode,
              error: null,
            } satisfies FetchedDisclosure;
          } catch (error) {
            return {
              url: hit.url,
              title: hit.title,
              snippet: hit.snippet,
              content: null,
              fetchMode: undefined,
              error: error instanceof Error ? error.message : String(error),
            } satisfies FetchedDisclosure;
          }
        }),
      );

      for (const result of searchResults) {
        sourceUrls.push(...result.urls.filter((url) => isOfficialDisclosureUrl(url)));
      }
      sourceUrls.push(...topHits.map((hit) => hit.url));

      return formatToolResult({
        plan,
        searches: searchResults.map((result) => ({
          query: result.query,
          error: result.error,
          hits: result.hits.slice(0, 5),
        })),
        fetchedPages: fetchResults,
        officialPages: canonicalUrls,
      }, Array.from(new Set(sourceUrls)));
    },
  });
}

// Backward-compatible export name while the tool registry migrates.
export const createReadFilings = createReadDisclosures;
