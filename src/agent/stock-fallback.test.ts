import { describe, expect, test } from 'bun:test';
import { buildStockAnalysisFallback, looksLikeClarificationResponse } from './stock-fallback.js';

function makeToolResult(data: unknown): string {
  return JSON.stringify({ data });
}

describe('stock fallback', () => {
  test('detects clarification-style answers', () => {
    expect(looksLikeClarificationResponse('Provide me with the stock symbol (ticker) of the company you are interested in.')).toBe(true);
    expect(looksLikeClarificationResponse('Here is the analysis.')).toBe(false);
  });

  test('builds a deterministic RELIANCE fallback from tool results', () => {
    const fallback = buildStockAnalysisFallback(
      'Analyze RELIANCE as a stock. Start with current price, valuation, growth, margins, free cash flow, debt, and a one-paragraph thesis. End with 3 risks',
      [
        {
          tool: 'get_market_data',
          args: { ticker: 'RELIANCE' },
          result: makeToolResult({
            ticker: 'RELIANCE.NSE',
            source_symbol: 'RELIANCE.NS',
            price: 1365,
            close: 1365,
            market_cap: 18471823867904,
            short_name: 'RELIANCE INDUSTRIES LTD',
            long_name: 'Reliance Industries Limited',
          }),
        },
        {
          tool: 'get_financials',
          args: { ticker: 'RELIANCE', data_type: 'all_statements' },
          result: makeToolResult({
            income_statements: [
              { report_period: '2022-03-31', revenue: 6946730000000, operating_margin: 0.16, net_income: 678450000000, earnings_per_share: 44.87 },
              { report_period: '2023-03-31', revenue: 8763960000000, operating_margin: 0.16, net_income: 740880000000, earnings_per_share: 49.29 },
              { report_period: '2024-03-31', revenue: 8990410000000, operating_margin: 0.18, net_income: 790200000000, earnings_per_share: 51.45 },
              { report_period: '2025-03-31', revenue: 9628200000000, operating_margin: 0.17, net_income: 813090000000, earnings_per_share: 51.47 },
            ],
            balance_sheets: [
              { report_period: '2025-03-31', total_debt: 3743130000000, shareholders_equity: 8432000000000 },
            ],
            cash_flow_statements: [
              { report_period: '2025-03-31', free_cash_flow: 410790000000, operating_cash_flow: 1787030000000 },
            ],
          }),
        },
      ],
      'Provide me with the stock symbol (ticker) of the company you are interested in, and I will fetch its data.',
    );

    expect(fallback).not.toBeNull();
    expect(fallback).toContain('₹1,365');
    expect(fallback).toContain('approximate trailing P/E');
    expect(fallback).toContain('26.5x');
    expect(fallback).toContain('Revenue rose');
    expect(fallback).toContain('₹41,079 Cr');
    expect(fallback).toContain('₹3,74,313 Cr');
    expect(fallback).toContain('Risks:');
  });
});