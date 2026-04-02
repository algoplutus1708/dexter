import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api, stripFieldsDeep } from './api.js';
import { formatToolResult } from '../types.js';
import { TTL_1H, TTL_6H } from './utils.js';
import { describeIndianTickerFormat, normalizeIndianTicker } from './india-market.js';

const REDUNDANT_FINANCIAL_FIELDS = ['accession_number', 'currency', 'period'] as const;

const KeyRatiosInputSchema = z.object({
  ticker: z
    .string()
    .describe(`The Indian listed instrument to fetch key ratios for. ${describeIndianTickerFormat()}`),
});

export const getKeyRatios = new DynamicStructuredTool({
  name: 'get_key_ratios',
  description:
    'Fetches the latest financial metrics snapshot for a company, including valuation ratios (P/E, P/B, P/S, EV/EBITDA, PEG), profitability (margins, ROE, ROA, ROIC), liquidity (current/quick/cash ratios), leverage (debt/equity, debt/assets), per-share metrics (EPS, book value, FCF), and growth rates (revenue, earnings, EPS, FCF, EBITDA).',
  schema: KeyRatiosInputSchema,
  func: async (input) => {
    if (!process.env.INDIA_MARKET_API_KEY && !process.env.FINANCIAL_DATASETS_API_KEY && !process.env.FINANCE_API_BASE_URL && !process.env.INDIA_MARKET_API_BASE_URL) {
      return formatToolResult({
        error: 'Structured key-ratio data is not configured in no-key mode. Add an India-market data provider for normalized valuation and profitability metrics.',
        ticker: normalizeIndianTicker(input.ticker),
      }, []);
    }
    const ticker = normalizeIndianTicker(input.ticker);
    const params = { ticker };
    const { data, url } = await api.get('/financial-metrics/snapshot/', params, { cacheable: true, ttlMs: TTL_1H });
    return formatToolResult(data.snapshot || {}, [url]);
  },
});

const HistoricalKeyRatiosInputSchema = z.object({
  ticker: z
    .string()
    .describe(`The Indian listed instrument to fetch historical key ratios for. ${describeIndianTickerFormat()}`),
  period: z
    .enum(['annual', 'quarterly', 'ttm'])
    .default('ttm')
    .describe(
      "The reporting period. 'annual' for yearly, 'quarterly' for quarterly, and 'ttm' for trailing twelve months."
    ),
  limit: z
    .number()
    .default(4)
    .describe('The number of past financial statements to retrieve.'),
  report_period: z
    .string()
    .optional()
    .describe('Filter for key ratios with an exact report period date (YYYY-MM-DD).'),
  report_period_gt: z
    .string()
    .optional()
    .describe('Filter for key ratios with report periods after this date (YYYY-MM-DD).'),
  report_period_gte: z
    .string()
    .optional()
    .describe(
      'Filter for key ratios with report periods on or after this date (YYYY-MM-DD).'
    ),
  report_period_lt: z
    .string()
    .optional()
    .describe('Filter for key ratios with report periods before this date (YYYY-MM-DD).'),
  report_period_lte: z
    .string()
    .optional()
    .describe(
      'Filter for key ratios with report periods on or before this date (YYYY-MM-DD).'
    ),
});

export const getHistoricalKeyRatios = new DynamicStructuredTool({
  name: 'get_historical_key_ratios',
  description: `Retrieves historical key ratios for a company, such as P/E ratio, revenue per share, and enterprise value, over a specified period. Useful for trend analysis and historical performance evaluation.`,
  schema: HistoricalKeyRatiosInputSchema,
  func: async (input) => {
    if (!process.env.INDIA_MARKET_API_KEY && !process.env.FINANCIAL_DATASETS_API_KEY && !process.env.FINANCE_API_BASE_URL && !process.env.INDIA_MARKET_API_BASE_URL) {
      return formatToolResult({
        error: 'Structured historical key-ratio data is not configured in no-key mode. Add an India-market data provider for normalized trend metrics.',
        ticker: normalizeIndianTicker(input.ticker),
      }, []);
    }
    const params: Record<string, string | number | undefined> = {
      ticker: normalizeIndianTicker(input.ticker),
      period: input.period,
      limit: input.limit,
      report_period: input.report_period,
      report_period_gt: input.report_period_gt,
      report_period_gte: input.report_period_gte,
      report_period_lt: input.report_period_lt,
      report_period_lte: input.report_period_lte,
    };
    const { data, url } = await api.get('/financial-metrics/', params, { cacheable: true, ttlMs: TTL_6H });
    return formatToolResult(
      stripFieldsDeep(data.financial_metrics || [], REDUNDANT_FINANCIAL_FIELDS),
      [url]
    );
  },
});
