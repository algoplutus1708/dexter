import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api } from './api.js';
import { formatToolResult } from '../types.js';
import { TTL_6H } from './utils.js';
import { describeIndianTickerFormat, normalizeIndianTicker } from './india-market.js';

const AnalystEstimatesInputSchema = z.object({
  ticker: z
    .string()
    .describe(`The Indian listed instrument to fetch analyst estimates for. ${describeIndianTickerFormat()}`),
  period: z
    .enum(['annual', 'quarterly'])
    .default('annual')
    .describe("The period for the estimates, either 'annual' or 'quarterly'."),
});

export const getAnalystEstimates = new DynamicStructuredTool({
  name: 'get_analyst_estimates',
  description: `Retrieves analyst estimates for a given company ticker, including metrics like estimated EPS. Useful for understanding consensus expectations, assessing future growth prospects, and performing valuation analysis.`,
  schema: AnalystEstimatesInputSchema,
  func: async (input) => {
    if (!process.env.INDIA_MARKET_API_KEY && !process.env.FINANCIAL_DATASETS_API_KEY && !process.env.FINANCE_API_BASE_URL && !process.env.INDIA_MARKET_API_BASE_URL) {
      return formatToolResult({
        error: 'Structured analyst estimates are not configured in no-key mode. Add an India-market data provider if you need consensus estimates.',
        ticker: normalizeIndianTicker(input.ticker),
      }, []);
    }
    const params = {
      ticker: normalizeIndianTicker(input.ticker),
      period: input.period,
    };
    const { data, url } = await api.get('/analyst-estimates/', params, { cacheable: true, ttlMs: TTL_6H });
    return formatToolResult(data.analyst_estimates || [], [url]);
  },
});
