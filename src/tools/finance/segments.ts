import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api, stripFieldsDeep } from './api.js';
import { formatToolResult } from '../types.js';
import { TTL_24H } from './utils.js';
import { describeIndianTickerFormat, normalizeIndianTicker } from './india-market.js';

const REDUNDANT_FINANCIAL_FIELDS = ['accession_number', 'currency', 'period'] as const;

const SegmentedRevenuesInputSchema = z.object({
  ticker: z
    .string()
    .describe(`The Indian listed instrument to fetch segmented revenues for. ${describeIndianTickerFormat()}`),
  period: z
    .enum(['annual', 'quarterly'])
    .describe(
      "The reporting period for the segmented revenues. 'annual' for yearly, 'quarterly' for quarterly."
    ),
  limit: z.number().default(4).describe('The number of past periods to retrieve (default: 4). Increase when broader historical segment trends are required.'),
});

export const getSegmentedRevenues = new DynamicStructuredTool({
  name: 'get_segmented_revenues',
  description: `Provides a detailed breakdown of a company's revenue by operating segments, such as products, services, or geographic regions. Useful for analyzing the composition of a company's revenue.`,
  schema: SegmentedRevenuesInputSchema,
  func: async (input) => {
    if (!process.env.INDIA_MARKET_API_KEY && !process.env.FINANCIAL_DATASETS_API_KEY && !process.env.FINANCE_API_BASE_URL && !process.env.INDIA_MARKET_API_BASE_URL) {
      return formatToolResult({
        error: 'Structured segment-revenue data is not configured in no-key mode. Add an India-market data provider for normalized segment disclosures.',
        ticker: normalizeIndianTicker(input.ticker),
      }, []);
    }
    const params = {
      ticker: normalizeIndianTicker(input.ticker),
      period: input.period,
      limit: input.limit,
    };
    const { data, url } = await api.get('/financials/segmented-revenues/', params, { cacheable: true, ttlMs: TTL_24H });
    return formatToolResult(
      stripFieldsDeep(data.segmented_revenues || {}, REDUNDANT_FINANCIAL_FIELDS),
      [url]
    );
  },
});
