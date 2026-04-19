import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { describeIndianTickerFormat } from './india-market.js';
import { withTimeout, SUB_TOOL_TIMEOUT_MS } from './utils.js';
import {
  getIncomeStatements,
  getBalanceSheets,
  getCashFlowStatements,
  getAllFinancialStatements,
} from './fundamentals.js';
import { getKeyRatios } from './key-ratios.js';
import { getAnalystEstimates } from './estimates.js';
import { getSegmentedRevenues } from './segments.js';
import { getEarnings } from './earnings.js';

export const GET_FINANCIALS_DESCRIPTION = `
Fetches authentic Indian company financial data from Screener.in (income statements, balance sheets, cash flows, key ratios).
Use for: P&L, revenue, net profit, EPS, ROE, margins, debt, cash flow.
Do NOT use for: live prices (use get_market_data), news (use web_search), exchange filings (use read_disclosures).
Defaults to all_statements for broad stock-analysis prompts.
`.trim();

function extractTickerCandidate(text: string): string | null {
  const matches = text.match(/\b[A-Z0-9][A-Z0-9.&:-]{1,}\b/g) ?? [];
  const tickerLike = matches.find((value) => /[A-Z]/.test(value));
  return tickerLike ?? null;
}

const GetFinancialsInputSchema = z.object({
  ticker: z
    .string()
    .optional()
    .describe(
      `Indian listed company ticker. ${describeIndianTickerFormat()} Examples: RELIANCE, TCS, HDFCBANK, INFY, TATAMOTORS, WIPRO, SBIN, ITC.`
    ),
  symbol: z
    .string()
    .optional()
    .describe('Alias for ticker, accepted for model compatibility.'),
  query: z
    .string()
    .optional()
    .describe('Optional natural-language stock analysis request. Used only if ticker/symbol is omitted.'),
  metric_groups: z
    .array(z.string())
    .optional()
    .describe('Optional metric groups requested by the model, such as valuation, growth, margins, cash_flow, and debt.'),
  data_type: z
    .enum([
      'income_statements',
      'balance_sheets',
      'cash_flow_statements',
      'all_statements',
      'key_ratios',
      'earnings',
    ])
    .default('all_statements')
    .describe(
      "What to fetch: 'income_statements' (revenue/profit/EPS), 'balance_sheets' (assets/liabilities/equity), 'cash_flow_statements' (FCF/OCF), 'all_statements' (all three combined, default), 'key_ratios' (P/E, ROE, margins), 'earnings' (latest quarterly results)."
    ),
  period: z
    .enum(['annual', 'quarterly'])
    .default('annual')
    .describe("Reporting period. Use 'quarterly' for recent quarter data, 'annual' for full-year trends."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(4)
    .describe('Number of periods to return (default 4). Use 8+ for multi-year trends.'),
});

type GetFinancialsInput = z.infer<typeof GetFinancialsInputSchema>;

function resolveTicker(input: GetFinancialsInput): string {
  const candidate = input.ticker ?? input.symbol ?? (input.query ? extractTickerCandidate(input.query) : null);

  if (!candidate) {
    throw new Error('Ticker is required for get_financials. Provide ticker or symbol.');
  }

  return candidate.trim().toUpperCase();
}

const asString = (p: Promise<unknown>): Promise<string> =>
  p.then((r) => (typeof r === 'string' ? r : JSON.stringify(r)));

async function dispatch(input: GetFinancialsInput): Promise<string> {
  const ticker = resolveTicker(input);
  const { data_type, period, limit } = input;
  const baseArgs = { ticker, period, limit };
  // Segments tool only supports annual/quarterly (no ttm)
  const segmentPeriod: 'annual' | 'quarterly' = period === 'annual' ? 'annual' : 'quarterly';

  switch (data_type) {
    case 'income_statements':
      return withTimeout(asString(getIncomeStatements.invoke(baseArgs)), SUB_TOOL_TIMEOUT_MS, 'income_statements');
    case 'balance_sheets':
      return withTimeout(asString(getBalanceSheets.invoke(baseArgs)), SUB_TOOL_TIMEOUT_MS, 'balance_sheets');
    case 'cash_flow_statements':
      return withTimeout(asString(getCashFlowStatements.invoke(baseArgs)), SUB_TOOL_TIMEOUT_MS, 'cash_flow_statements');
    case 'all_statements':
      return withTimeout(asString(getAllFinancialStatements.invoke(baseArgs)), SUB_TOOL_TIMEOUT_MS, 'all_statements');
    case 'key_ratios':
      return withTimeout(asString(getKeyRatios.invoke({ ticker })), SUB_TOOL_TIMEOUT_MS, 'key_ratios');
    case 'earnings':
      return withTimeout(asString(getEarnings.invoke({ ticker })), SUB_TOOL_TIMEOUT_MS, 'earnings');
    default:
      throw new Error(`Unknown data_type: ${data_type}`);
  }
}

/**
 * Deterministic financial data fetcher for Indian equities.
 *
 * Uses a simple 2-field schema (ticker + data_type enum) so Qwen 2.5 / Ollama
 * always generates valid tool calls. No nested LLM routing — dispatches directly
 * to Screener.in browser scrapers and financial API sub-tools.
 */
export function createGetFinancials(_model: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'get_financials',
    description:
      "Fetches Indian company financial data from Screener.in. Pass ticker or symbol + data_type. data_type options: 'income_statements' (revenue/profit/EPS/margins), 'balance_sheets' (assets/debt/equity), 'cash_flow_statements' (OCF/FCF), 'all_statements' (all three, default), 'key_ratios' (P/E/ROE/dividend yield), 'earnings' (latest quarterly results).",
    schema: GetFinancialsInputSchema,
    func: async (input, _runManager, config?: RunnableConfig) => {
      const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;
      const ticker = resolveTicker(input);
      onProgress?.(`Fetching ${input.data_type} for ${ticker} from Screener.in...`);
      try {
        return await dispatch(input);
      } catch (error) {
        return formatToolResult(
          {
            error: `Failed to fetch ${input.data_type} for ${ticker}`,
            details: error instanceof Error ? error.message : String(error),
          },
          [],
        );
      }
    },
  });
}
