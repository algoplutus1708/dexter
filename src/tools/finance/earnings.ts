import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api } from './api.js';
import { formatToolResult } from '../types.js';
import { TTL_24H } from './utils.js';
import { describeIndianTickerFormat, normalizeIndianTicker } from './india-market.js';

const EarningsInputSchema = z.object({
  ticker: z
    .string()
    .describe(`The Indian listed instrument to fetch the latest results snapshot for. ${describeIndianTickerFormat()}`),
});

export const getEarnings = new DynamicStructuredTool({
  name: 'get_earnings',
  description:
    'Fetches the most recent quarterly/annual results snapshot for an Indian listed company, including key financial figures and estimate comparisons when available from the configured provider.',
  schema: EarningsInputSchema,
  func: async (input) => {
    if (!process.env.INDIA_MARKET_API_KEY && !process.env.FINANCIAL_DATASETS_API_KEY && !process.env.FINANCE_API_BASE_URL && !process.env.INDIA_MARKET_API_BASE_URL) {
      return formatToolResult({
        error: 'Structured results snapshots are not configured in no-key mode. Use read_disclosures for official quarterly/annual filings, or add an India-market provider for normalized earnings data.',
        ticker: normalizeIndianTicker(input.ticker),
      }, []);
    }
    const ticker = normalizeIndianTicker(input.ticker);
    const { data, url } = await api.get('/earnings', { ticker }, { cacheable: true, ttlMs: TTL_24H });
    return formatToolResult(data.earnings || {}, [url]);
  },
});
