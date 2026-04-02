import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { callLlm } from '../../model/llm.js';
import { formatToolResult, parseSearchResults } from '../types.js';
import { getCurrentDate } from '../../agent/prompts.js';
import { webFetchTool } from '../fetch/web-fetch.js';
import { exaSearch, perplexitySearch, tavilySearch } from '../search/index.js';
import {
  buildCanonicalDisclosureUrls,
  buildIndiaDisclosureQueries,
  INDIA_DISCLOSURE_DOMAINS,
  INDIA_DISCLOSURE_TYPES,
  type IndiaDisclosureType,
} from './india-market.js';

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
            const raw = await webFetchTool.invoke({
              url: hit.url,
              extractMode: 'text',
              maxChars: 6000,
            });
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return {
              url: hit.url,
              title: hit.title,
              snippet: hit.snippet,
              content: parsed,
              error: null,
            };
          } catch (error) {
            return {
              url: hit.url,
              title: hit.title,
              snippet: hit.snippet,
              content: null,
              error: error instanceof Error ? error.message : String(error),
            };
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
