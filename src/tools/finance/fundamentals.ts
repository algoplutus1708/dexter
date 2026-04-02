import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api, stripFieldsDeep } from './api.js';
import { formatToolResult } from '../types.js';
import { TTL_24H } from './utils.js';
import { describeIndianTickerFormat, normalizeIndianTicker } from './india-market.js';

const REDUNDANT_FINANCIAL_FIELDS = ['accession_number', 'currency', 'period'] as const;

const FinancialStatementsInputSchema = z.object({
  ticker: z
    .string()
    .describe(`The Indian listed instrument to fetch financial statements for. ${describeIndianTickerFormat()}`),
  period: z
    .enum(['annual', 'quarterly', 'ttm'])
    .describe(
      "The reporting period for the financial statements. 'annual' for yearly, 'quarterly' for quarterly, and 'ttm' for trailing twelve months."
    ),
  limit: z
    .number()
    .default(4)
    .describe(
      'Maximum number of report periods to return (default: 4). Returns the most recent N periods based on the period type. Increase this for longer historical analysis when needed.'
    ),
  report_period_gt: z
    .string()
    .optional()
    .describe('Filter for financial statements with report periods after this date (YYYY-MM-DD).'),
  report_period_gte: z
    .string()
    .optional()
    .describe(
      'Filter for financial statements with report periods on or after this date (YYYY-MM-DD).'
    ),
  report_period_lt: z
    .string()
    .optional()
    .describe('Filter for financial statements with report periods before this date (YYYY-MM-DD).'),
  report_period_lte: z
    .string()
    .optional()
    .describe(
      'Filter for financial statements with report periods on or before this date (YYYY-MM-DD).'
    ),
});

function createParams(input: z.infer<typeof FinancialStatementsInputSchema>): Record<string, string | number | undefined> {
  return {
    ticker: normalizeIndianTicker(input.ticker),
    period: input.period,
    limit: input.limit,
    report_period_gt: input.report_period_gt,
    report_period_gte: input.report_period_gte,
    report_period_lt: input.report_period_lt,
    report_period_lte: input.report_period_lte,
  };
}

type StatementKind = 'income' | 'balance' | 'cashflow' | 'all';

type ProviderAdapter = {
  endpoint: (kind: StatementKind) => string;
  buildParams: (input: z.infer<typeof FinancialStatementsInputSchema>) => Record<string, string | number | undefined>;
  extract: (kind: StatementKind, data: Record<string, unknown>) => unknown;
};

function detectFundamentalsProvider(): 'legacy' | 'india' {
  return process.env.INDIA_MARKET_API_BASE_URL || process.env.FINANCE_API_BASE_URL
    ? 'india'
    : 'legacy';
}

function normalizeStatementRows(value: unknown): unknown[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? [value]
      : [];

  return rows.map((row) => {
    const rec = row as Record<string, unknown>;
    const reportPeriod = rec.report_period ?? rec.fiscal_date ?? rec.date ?? rec.period_end ?? null;
    const period = rec.period ?? rec.statement_period ?? null;

    return {
      ...rec,
      report_period: reportPeriod,
      period,
      currency: rec.currency ?? 'INR',
      accession_number: rec.accession_number ?? rec.document_id ?? rec.filing_reference ?? null,
    };
  });
}

function normalizeCombinedStatements(value: unknown): Record<string, unknown> {
  const rec = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    income_statements: normalizeStatementRows(rec.income_statements ?? rec.income ?? rec.profit_and_loss ?? rec.pnl),
    balance_sheets: normalizeStatementRows(rec.balance_sheets ?? rec.balance_sheet ?? rec.balance),
    cash_flow_statements: normalizeStatementRows(rec.cash_flow_statements ?? rec.cash_flow ?? rec.cashflows),
  };
}

const FUNDAMENTALS_ADAPTERS: Record<'legacy' | 'india', ProviderAdapter> = {
  legacy: {
    endpoint: (kind) => {
      switch (kind) {
        case 'income':
          return '/financials/income-statements/';
        case 'balance':
          return '/financials/balance-sheets/';
        case 'cashflow':
          return '/financials/cash-flow-statements/';
        case 'all':
          return '/financials/';
      }
    },
    buildParams: createParams,
    extract: (kind, data) => {
      switch (kind) {
        case 'income':
          return normalizeStatementRows(data.income_statements);
        case 'balance':
          return normalizeStatementRows(data.balance_sheets);
        case 'cashflow':
          return normalizeStatementRows(data.cash_flow_statements);
        case 'all':
          return normalizeCombinedStatements(data.financials);
      }
    },
  },
  india: {
    endpoint: (kind) => {
      switch (kind) {
        case 'income':
          return '/indian-market/fundamentals/income-statements/';
        case 'balance':
          return '/indian-market/fundamentals/balance-sheets/';
        case 'cashflow':
          return '/indian-market/fundamentals/cash-flow-statements/';
        case 'all':
          return '/indian-market/fundamentals/';
      }
    },
    buildParams: (input) => ({
      symbol: normalizeIndianTicker(input.ticker),
      statement_period: input.period,
      limit: input.limit,
      from_date: input.report_period_gte ?? input.report_period_gt,
      to_date: input.report_period_lte ?? input.report_period_lt,
    }),
    extract: (kind, data) => {
      switch (kind) {
        case 'income':
          return normalizeStatementRows(data.income_statements ?? data.data ?? data.results ?? data.statements);
        case 'balance':
          return normalizeStatementRows(data.balance_sheets ?? data.data ?? data.results ?? data.statements);
        case 'cashflow':
          return normalizeStatementRows(data.cash_flow_statements ?? data.data ?? data.results ?? data.statements);
        case 'all':
          return normalizeCombinedStatements(data.financials ?? data.data ?? data.results ?? data);
      }
    },
  },
};

async function fetchFundamentals(
  kind: StatementKind,
  input: z.infer<typeof FinancialStatementsInputSchema>,
): Promise<{ data: unknown; url: string }> {
  const adapter = FUNDAMENTALS_ADAPTERS[detectFundamentalsProvider()];
  const { data, url } = await api.get(
    adapter.endpoint(kind),
    adapter.buildParams(input),
    { cacheable: true, ttlMs: TTL_24H },
  );
  return { data: adapter.extract(kind, data), url };
}

function ensureStructuredProvider(): string | null {
  if (
    process.env.FINANCE_API_BASE_URL ||
    process.env.INDIA_MARKET_API_BASE_URL ||
    process.env.INDIA_MARKET_API_KEY ||
    process.env.FINANCIAL_DATASETS_API_KEY
  ) {
    return null;
  }

  return 'Structured fundamentals are not configured in no-key mode. The India-only app can still use public price/history fallback and official exchange disclosures, but you need an India-market data provider for normalized statements.';
}

export const getIncomeStatements = new DynamicStructuredTool({
  name: 'get_income_statements',
  description: `Fetches a company's income statements, detailing its revenues, expenses, net income, etc. over a reporting period. Useful for evaluating a company's profitability and operational efficiency.`,
  schema: FinancialStatementsInputSchema,
  func: async (input) => {
    const providerError = ensureStructuredProvider();
    if (providerError) return formatToolResult({ error: providerError, ticker: normalizeIndianTicker(input.ticker) }, []);
    const { data, url } = await fetchFundamentals('income', input);
    return formatToolResult(
      stripFieldsDeep(data || {}, REDUNDANT_FINANCIAL_FIELDS),
      [url]
    );
  },
});

export const getBalanceSheets = new DynamicStructuredTool({
  name: 'get_balance_sheets',
  description: `Retrieves a company's balance sheets, providing a snapshot of its assets, liabilities, shareholders' equity, etc. at a specific point in time. Useful for assessing a company's financial position.`,
  schema: FinancialStatementsInputSchema,
  func: async (input) => {
    const providerError = ensureStructuredProvider();
    if (providerError) return formatToolResult({ error: providerError, ticker: normalizeIndianTicker(input.ticker) }, []);
    const { data, url } = await fetchFundamentals('balance', input);
    return formatToolResult(
      stripFieldsDeep(data || {}, REDUNDANT_FINANCIAL_FIELDS),
      [url]
    );
  },
});

export const getCashFlowStatements = new DynamicStructuredTool({
  name: 'get_cash_flow_statements',
  description: `Retrieves a company's cash flow statements, showing how cash is generated and used across operating, investing, and financing activities. Useful for understanding a company's liquidity and solvency.`,
  schema: FinancialStatementsInputSchema,
  func: async (input) => {
    const providerError = ensureStructuredProvider();
    if (providerError) return formatToolResult({ error: providerError, ticker: normalizeIndianTicker(input.ticker) }, []);
    const { data, url } = await fetchFundamentals('cashflow', input);
    return formatToolResult(
      stripFieldsDeep(data || {}, REDUNDANT_FINANCIAL_FIELDS),
      [url]
    );
  },
});

export const getAllFinancialStatements = new DynamicStructuredTool({
  name: 'get_all_financial_statements',
  description: `Retrieves all three financial statements (income statements, balance sheets, and cash flow statements) for a company in a single API call. This is more efficient than calling each statement type separately when you need all three for comprehensive financial analysis.`,
  schema: FinancialStatementsInputSchema,
  func: async (input) => {
    const providerError = ensureStructuredProvider();
    if (providerError) return formatToolResult({ error: providerError, ticker: normalizeIndianTicker(input.ticker) }, []);
    const { data, url } = await fetchFundamentals('all', input);
    return formatToolResult(
      stripFieldsDeep(data || {}, REDUNDANT_FINANCIAL_FIELDS),
      [url]
    );
  },
});
