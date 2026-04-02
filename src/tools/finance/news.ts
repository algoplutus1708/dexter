import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api } from './api.js';
import { formatToolResult } from '../types.js';
import { TTL_15M } from './utils.js';
import { describeIndianTickerFormat, normalizeIndianTicker } from './india-market.js';

const CompanyNewsInputSchema = z.object({
  ticker: z
    .string()
    .describe(`The Indian listed instrument to fetch company news for. ${describeIndianTickerFormat()}`),
  limit: z
    .number()
    .default(5)
    .describe('Maximum number of news articles to return (default: 5, max: 10).'),
});

export const getCompanyNews = new DynamicStructuredTool({
  name: 'get_company_news',
  description:
    'Retrieves recent company news headlines for a stock ticker, including title, source, publication date, and URL. Use for company catalysts, price move explanations, press releases, and recent announcements.',
  schema: CompanyNewsInputSchema,
  func: async (input) => {
    if (!process.env.INDIA_MARKET_API_KEY && !process.env.FINANCIAL_DATASETS_API_KEY && !process.env.FINANCE_API_BASE_URL && !process.env.INDIA_MARKET_API_BASE_URL) {
      return formatToolResult({
        note: 'Structured company-news feeds are not configured in no-key mode. Use read_disclosures for official NSE/BSE/SEBI documents, or configure web search for broader news discovery.',
        ticker: normalizeIndianTicker(input.ticker),
      }, []);
    }
    const params: Record<string, string | number | undefined> = {
      ticker: normalizeIndianTicker(input.ticker),
      limit: Math.min(input.limit, 10),
    };
    const { data, url } = await api.get('/news', params, { cacheable: true, ttlMs: TTL_15M });
    return formatToolResult((data.news as unknown[]) || [], [url]);
  },
});
