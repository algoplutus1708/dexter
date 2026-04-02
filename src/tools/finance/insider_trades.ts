import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api, stripFieldsDeep } from './api.js';
import { formatToolResult } from '../types.js';
import { TTL_1H } from './utils.js';
import { describeIndianTickerFormat, normalizeIndianTicker } from './india-market.js';

const REDUNDANT_INSIDER_FIELDS = ['issuer'] as const;

const InsiderTradesInputSchema = z.object({
  ticker: z
    .string()
    .describe(`The Indian listed instrument to fetch insider/promoter disclosures for. ${describeIndianTickerFormat()}`),
  limit: z
    .number()
    .default(10)
    .describe('Maximum number of insider trades to return (default: 10, max: 1000). Increase this for longer historical windows when needed.'),
  filing_date: z
    .string()
    .optional()
    .describe('Exact filing date to filter by (YYYY-MM-DD).'),
  filing_date_gte: z
    .string()
    .optional()
    .describe('Filter for trades with filing date greater than or equal to this date (YYYY-MM-DD).'),
  filing_date_lte: z
    .string()
    .optional()
    .describe('Filter for trades with filing date less than or equal to this date (YYYY-MM-DD).'),
  filing_date_gt: z
    .string()
    .optional()
    .describe('Filter for trades with filing date greater than this date (YYYY-MM-DD).'),
  filing_date_lt: z
    .string()
    .optional()
    .describe('Filter for trades with filing date less than this date (YYYY-MM-DD).'),
});

export const getInsiderTrades = new DynamicStructuredTool({
  name: 'get_insider_trades',
  description: `Retrieves insider and promoter trading disclosures for a given Indian listed company. Depending on the configured provider, this may include SEBI PIT-style disclosures, promoter transactions, or management trades. Use filing_date filters to narrow down results by date range.`,
  schema: InsiderTradesInputSchema,
  func: async (input) => {
    if (!process.env.INDIA_MARKET_API_KEY && !process.env.FINANCIAL_DATASETS_API_KEY && !process.env.FINANCE_API_BASE_URL && !process.env.INDIA_MARKET_API_BASE_URL) {
      return formatToolResult({
        note: 'Structured insider/promoter trade feeds are not configured in no-key mode. Use read_disclosures for official exchange or SEBI disclosure discovery, or add an India-market provider for richer structured data.',
        ticker: normalizeIndianTicker(input.ticker),
      }, []);
    }
    const params: Record<string, string | number | undefined> = {
      ticker: normalizeIndianTicker(input.ticker),
      limit: input.limit,
      filing_date: input.filing_date,
      filing_date_gte: input.filing_date_gte,
      filing_date_lte: input.filing_date_lte,
      filing_date_gt: input.filing_date_gt,
      filing_date_lt: input.filing_date_lt,
    };
    const { data, url } = await api.get('/insider-trades/', params, { cacheable: true, ttlMs: TTL_1H });
    return formatToolResult(
      stripFieldsDeep(data.insider_trades || [], REDUNDANT_INSIDER_FIELDS),
      [url]
    );
  },
});
