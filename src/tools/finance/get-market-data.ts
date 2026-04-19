import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { getCurrentDate } from '../../agent/prompts.js';
import { normalizeIndianTicker } from './india-market.js';
import {
  getYahooIndiaHistory,
  getYahooIndiaQuote,
  getYahooIndiaSnapshotFromChart,
} from './yahoo-india.js';
import {
  formatUpstoxAuthExpiredResult,
  getUpstoxHistory,
  getUpstoxQuote,
  hasUpstoxAccessToken,
  UpstoxAuthExpiredError,
} from './upstox.js';

/**
 * Rich description for the get_market_data tool.
 * Used in the system prompt to guide the LLM on when and how to use this tool.
 */
export const GET_MARKET_DATA_DESCRIPTION = `
Fetches live Indian stock and index prices. Returns open, high, low, close, volume, market cap, and 52-week range.
Use for: current price, today's range, market cap, 52-week high/low.
Do NOT use for: financials, ratios, news, disclosures.

Current date: ${getCurrentDate()}
`.trim();
function extractTickerCandidate(text: string): string | null {
  const matches = text.match(/\b[A-Z0-9][A-Z0-9.&:-]{1,}\b/g) ?? [];
  const tickerLike = matches.find((value) => /[A-Z]/.test(value));
  return tickerLike ?? null;
}

// ─── Schema: ticker plus compatibility aliases ────────────────────────────
// Qwen 2.5 (Ollama) can omit the canonical ticker field, so we accept
// symbol/query aliases and normalize them before fetching data.

const GetMarketDataInputSchema = z.object({
  ticker: z
    .string()
    .optional()
    .describe("Indian stock ticker symbol to look up. Examples: RELIANCE, TATAMOTORS, HDFCBANK, INFY, TCS, SBIN, NIFTY50, SENSEX. Append .NSE or .BSE for explicit exchange (default NSE)."),
  symbol: z
    .string()
    .optional()
    .describe('Alias for ticker, accepted for model compatibility.'),
  tickers: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Alias for ticker, accepted for model compatibility.'),
  query: z
    .string()
    .optional()
    .describe('Optional natural-language stock query. Used only if ticker/symbol is omitted.'),
});

/**
 * Fetches live Indian stock price. Priority: Upstox → Yahoo Finance India.
 * Accepts ticker aliases so Ollama/Qwen tool calls are easier to recover.
 */
export function createGetMarketData(_model: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'get_market_data',
    description:
      'Fetches the LIVE current price for an Indian stock or index from Yahoo Finance India / Upstox. Returns: price, open, high, low, close, volume, market cap, 52-week high/low. Pass only the ticker symbol (e.g. RELIANCE, TATAMOTORS, HDFCBANK, INFY, NIFTY50).',
    schema: GetMarketDataInputSchema,
    func: async (input, _runManager, config?: RunnableConfig) => {
      const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;
      let candidate = input.ticker ?? input.symbol ?? (input.query ? extractTickerCandidate(input.query) : null);
      if (!candidate && (input as any).tickers) {
        candidate = Array.isArray((input as any).tickers) ? (input as any).tickers[0] : (input as any).tickers;
      }
      if (typeof candidate === 'string' && candidate.includes(',')) {
        candidate = candidate.split(',')[0];
      }
      if (!candidate) {
        return formatToolResult({ error: 'Ticker is required for get_market_data. Provide ticker or symbol.' }, []);
      }

      const ticker = normalizeIndianTicker(candidate);
      onProgress?.(`Fetching live price for ${ticker}...`);

      // Priority 1: Upstox (real-time authenticated Indian data)
      if (hasUpstoxAccessToken()) {
        try {
          const result = await getUpstoxQuote(ticker);
          return formatToolResult(result.data, [result.url]);
        } catch (error) {
          if (error instanceof UpstoxAuthExpiredError) {
            return formatUpstoxAuthExpiredResult();
          }
          // Fall through to Yahoo on Upstox errors
        }
      }

      // Priority 2: Yahoo Finance India (free, no API key required)
      try {
        const result = await getYahooIndiaQuote(ticker);
        return formatToolResult(result.data, [result.url]);
      } catch {
        // Priority 3: Yahoo chart endpoint (more resilient to rate limits)
        try {
          const result = await getYahooIndiaSnapshotFromChart(ticker);
          return formatToolResult(result.data, [result.url]);
        } catch (err) {
          return formatToolResult(
            { error: `Failed to fetch price for ${ticker}`, details: String(err) },
            [],
          );
        }
      }
    },
  });
}

// ─── Historical Price Tool (separate, simple schema) ───────────────────────

const GetHistoricalPricesSchema = z.object({
  ticker: z
    .string()
    .describe("Indian stock ticker. Examples: RELIANCE, TATAMOTORS, HDFCBANK, INFY, TCS."),
  start_date: z.string().describe('Start date in YYYY-MM-DD format.'),
  end_date: z.string().describe('End date in YYYY-MM-DD format.'),
  interval: z
    .enum(['day', 'week', 'month'])
    .default('day')
    .describe("Candle interval. Default 'day'."),
});

export const getHistoricalIndianPrices = new DynamicStructuredTool({
  name: 'get_historical_prices',
  description:
    'Fetches historical OHLCV price data for an Indian stock over a date range. Use for charts, price trends, backtesting. Pass ticker + start_date + end_date in YYYY-MM-DD format.',
  schema: GetHistoricalPricesSchema,
  func: async (input) => {
    const ticker = normalizeIndianTicker(input.ticker);

    if (hasUpstoxAccessToken()) {
      try {
        const result = await getUpstoxHistory({
          ticker,
          interval: input.interval as 'day' | 'week' | 'month' | 'year',
          start_date: input.start_date,
          end_date: input.end_date,
        });
        return formatToolResult(result.data, [result.url]);
      } catch (error) {
        if (error instanceof UpstoxAuthExpiredError) {
          return formatUpstoxAuthExpiredResult();
        }
      }
    }

    const result = await getYahooIndiaHistory({
      ticker,
      interval: input.interval as 'day' | 'week' | 'month' | 'year',
      start_date: input.start_date,
      end_date: input.end_date,
    });
    return formatToolResult(result.data, [result.url]);
  },
});
