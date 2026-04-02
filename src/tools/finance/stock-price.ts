import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api } from './api.js';
import { formatToolResult } from '../types.js';
import { describeIndianTickerFormat, normalizeIndianTicker } from './india-market.js';
import {
  getYahooIndiaHistory,
  getYahooIndiaQuote,
  getYahooIndiaSnapshotFromChart,
  hasStructuredFinanceProvider,
} from './yahoo-india.js';
import { getUpstoxHistory, getUpstoxQuote, hasUpstoxAccessToken } from './upstox.js';

export const STOCK_PRICE_DESCRIPTION = `
Fetches current stock price snapshots for equities, including open, high, low, close prices, volume, and market cap. Powered by Financial Datasets.
`.trim();

const StockPriceInputSchema = z.object({
  ticker: z
    .string()
    .describe(`The Indian market instrument to fetch current price for. ${describeIndianTickerFormat()}`),
});

export const getStockPrice = new DynamicStructuredTool({
  name: 'get_stock_price',
  description:
    'Fetches the current price snapshot for an Indian-market instrument, including open, high, low, close, volume, and market cap when available.',
  schema: StockPriceInputSchema,
  func: async (input) => {
    const ticker = normalizeIndianTicker(input.ticker);
    if (hasUpstoxAccessToken()) {
      const upstox = await getUpstoxQuote(ticker);
      return formatToolResult(upstox.data, [upstox.url]);
    }
    if (!hasStructuredFinanceProvider()) {
      const fallback = await getYahooIndiaQuote(ticker).catch(() => getYahooIndiaSnapshotFromChart(ticker));
      return formatToolResult(fallback.data, [fallback.url]);
    }
    const params = { ticker };
    const { data, url } = await api.get('/prices/snapshot/', params);
    return formatToolResult(data.snapshot || {}, [url]);
  },
});

const StockPricesInputSchema = z.object({
  ticker: z
    .string()
    .describe(`The Indian market instrument to fetch historical prices for. ${describeIndianTickerFormat()}`),
  interval: z
    .enum(['day', 'week', 'month', 'year'])
    .default('day')
    .describe("The time interval for price data. Defaults to 'day'."),
  start_date: z.string().describe('Start date in YYYY-MM-DD format. Required.'),
  end_date: z.string().describe('End date in YYYY-MM-DD format. Required.'),
});

export const getStockPrices = new DynamicStructuredTool({
  name: 'get_stock_prices',
  description:
    'Retrieves historical price data for an Indian-market instrument over a specified date range, including OHLC and volume.',
  schema: StockPricesInputSchema,
  func: async (input) => {
    if (hasUpstoxAccessToken()) {
      const upstox = await getUpstoxHistory({
        ticker: input.ticker,
        interval: input.interval,
        start_date: input.start_date,
        end_date: input.end_date,
      });
      return formatToolResult(upstox.data, [upstox.url]);
    }
    if (!hasStructuredFinanceProvider()) {
      const fallback = await getYahooIndiaHistory({
        ticker: input.ticker,
        interval: input.interval,
        start_date: input.start_date,
        end_date: input.end_date,
      });
      return formatToolResult(fallback.data, [fallback.url]);
    }
    const params = {
      ticker: normalizeIndianTicker(input.ticker),
      interval: input.interval,
      start_date: input.start_date,
      end_date: input.end_date,
    };
    // Cache when the date window is fully closed (OHLCV data is final)
    const endDate = new Date(input.end_date + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { data, url } = await api.get('/prices/', params, { cacheable: endDate < today });
    return formatToolResult(data.prices || [], [url]);
  },
});

export const getStockTickers = new DynamicStructuredTool({
  name: 'get_available_stock_tickers',
  description: 'Retrieves the list of available Indian-market tickers that can be used with the price tools.',
  schema: z.object({}),
  func: async () => {
    if (!hasStructuredFinanceProvider()) {
      return formatToolResult([
        'RELIANCE.NSE',
        'TCS.NSE',
        'INFY.NSE',
        'HDFCBANK.NSE',
        'SBIN.NSE',
        'NIFTY 50',
        'NIFTY BANK',
        'SENSEX',
      ], []);
    }
    const { data, url } = await api.get('/prices/snapshot/tickers/', {}, { cacheable: true, ttlMs: 24 * 60 * 60 * 1000 });
    return formatToolResult(data.tickers || [], [url]);
  },
});
