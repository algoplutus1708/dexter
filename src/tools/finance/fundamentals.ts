import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { stripFieldsDeep } from './api.js';
import { formatToolResult } from '../types.js';
import { closeBrowser, ensureBrowser, extractTablesFromPage, type ExtractedTable } from '../browser/browser.js';
import {
  describeIndianTickerFormat,
  getTickerSymbol,
  normalizeIndianTicker,
} from './india-market.js';

const REDUNDANT_FINANCIAL_FIELDS = ['accession_number', 'currency', 'period'] as const;
const CRORE_TO_RUPEES = 10_000_000;
const SCREENER_TABLE_SELECTORS = ['#quarters', '#profit-loss', '#balance-sheet', '#cash-flow'] as const;

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

type FinancialStatementsInput = z.infer<typeof FinancialStatementsInputSchema>;
type StatementKind = 'income' | 'balance' | 'cashflow' | 'all';
type BrowserTableSelector = typeof SCREENER_TABLE_SELECTORS[number];
type StatementPeriod = 'annual' | 'quarterly' | 'ttm';

type BrowserTable = ExtractedTable & {
  selector: BrowserTableSelector;
};

type ScrapedTables = Partial<Record<BrowserTableSelector, BrowserTable>>;

type ParsedPeriodColumn = {
  header: string;
  index: number;
  reportPeriod: string | null;
  month: number | null;
  isTtm: boolean;
};

type SelectedPeriodColumn = ParsedPeriodColumn & {
  period: StatementPeriod;
};

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

function isBrowserTable(value: unknown): value is BrowserTable {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.selector === 'string' &&
    Array.isArray(rec.headers) &&
    Array.isArray(rec.rows)
  );
}

function buildScreenerCompanyUrl(ticker: string): string {
  const symbol = encodeURIComponent(getTickerSymbol(ticker));
  return `https://www.screener.in/company/${symbol}/consolidated/`;
}

function normalizeMetricLabel(label: string): string {
  return label
    .replace(/\u00a0/g, ' ')
    .replace(/\+/g, ' ')
    .replace(/[():]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseNumericCell(value: string): number | null {
  const normalized = value
    .replace(/\u00a0/g, ' ')
    .replace(/[₹,]/g, '')
    .replace(/[–—]/g, '-')
    .replace(/\(([^)]+)\)/g, '-$1')
    .trim();

  if (!normalized || !/[0-9]/.test(normalized)) {
    return null;
  }

  const numeric = normalized.replace(/[^0-9.\-]/g, '');
  if (!numeric || numeric === '-' || numeric === '.' || numeric === '-.') {
    return null;
  }

  const parsed = Number(numeric);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCroreCell(value: string): number | null {
  const parsed = parseNumericCell(value);
  return parsed === null ? null : parsed * CRORE_TO_RUPEES;
}

function parsePercentCell(value: string): number | null {
  const parsed = parseNumericCell(value);
  return parsed === null ? null : parsed / 100;
}

function parsePlainNumberCell(value: string): number | null {
  return parseNumericCell(value);
}

function buildMetricLookup(table: BrowserTable, columnIndex: number): Map<string, string> {
  return new Map(
    table.rows.map((row) => [
      normalizeMetricLabel(row.label),
      row.values[columnIndex] ?? '',
    ]),
  );
}

function readMetricValue(
  lookup: Map<string, string>,
  labels: string[],
  parser: (value: string) => number | null,
): number | null {
  for (const label of labels) {
    const raw = lookup.get(normalizeMetricLabel(label));
    if (!raw) continue;
    const parsed = parser(raw);
    if (parsed !== null) return parsed;
  }
  return null;
}

function sumNullable(...values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (present.length === 0) return null;
  return present.reduce((total, value) => total + value, 0);
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function parsePeriodColumn(header: string, index: number): ParsedPeriodColumn {
  const cleaned = header.replace(/\s+/g, ' ').trim();
  if (cleaned.toUpperCase() === 'TTM') {
    return {
      header: cleaned,
      index,
      reportPeriod: 'TTM',
      month: null,
      isTtm: true,
    };
  }

  const match = cleaned.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})$/i);
  if (!match) {
    return {
      header: cleaned,
      index,
      reportPeriod: null,
      month: null,
      isTtm: false,
    };
  }

  const month = MONTH_INDEX[match[1].toLowerCase()];
  const year = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const reportPeriod = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  return {
    header: cleaned,
    index,
    reportPeriod,
    month,
    isTtm: false,
  };
}

function getDominantMonth(headers: string[]): number | null {
  const counts = new Map<number, number>();

  for (const header of headers) {
    const parsed = parsePeriodColumn(header, 0);
    if (parsed.isTtm || parsed.month === null) continue;
    counts.set(parsed.month, (counts.get(parsed.month) ?? 0) + 1);
  }

  let dominantMonth: number | null = null;
  let dominantCount = 0;
  for (const [month, count] of counts.entries()) {
    if (count > dominantCount) {
      dominantMonth = month;
      dominantCount = count;
    }
  }

  return dominantMonth;
}

function hasDateFilters(input: FinancialStatementsInput): boolean {
  return Boolean(
    input.report_period_gt ||
    input.report_period_gte ||
    input.report_period_lt ||
    input.report_period_lte,
  );
}

function matchesDateFilters(reportPeriod: string | null, input: FinancialStatementsInput): boolean {
  if (!reportPeriod || reportPeriod === 'TTM') {
    return !hasDateFilters(input);
  }

  if (input.report_period_gt && !(reportPeriod > input.report_period_gt)) return false;
  if (input.report_period_gte && !(reportPeriod >= input.report_period_gte)) return false;
  if (input.report_period_lt && !(reportPeriod < input.report_period_lt)) return false;
  if (input.report_period_lte && !(reportPeriod <= input.report_period_lte)) return false;
  return true;
}

function selectColumns(
  headers: string[],
  input: FinancialStatementsInput,
  tableMode: 'annual' | 'quarterly',
): SelectedPeriodColumn[] {
  const parsed = headers.map((header, index) => parsePeriodColumn(header, index));
  const dominantMonth = tableMode === 'annual' ? getDominantMonth(headers) : null;

  let selected: SelectedPeriodColumn[];

  switch (input.period) {
    case 'annual':
      selected = parsed
        .filter((column) => !column.isTtm && (dominantMonth === null || column.month === dominantMonth))
        .map((column) => ({ ...column, period: 'annual' as const }));
      break;

    case 'quarterly':
      if (tableMode === 'quarterly') {
        selected = parsed
          .filter((column) => !column.isTtm)
          .map((column) => ({ ...column, period: 'quarterly' as const }));
      } else {
        selected = parsed
          .filter((column) => !column.isTtm && dominantMonth !== null && column.month !== dominantMonth)
          .map((column) => ({ ...column, period: 'quarterly' as const }));
      }
      break;

    case 'ttm': {
      const ttmColumns = parsed.filter((column) => column.isTtm);
      if (ttmColumns.length > 0) {
        selected = ttmColumns.map((column) => ({ ...column, period: 'ttm' as const }));
      } else {
        selected = parsed
          .filter((column) => !column.isTtm)
          .slice(-1)
          .map((column) => ({ ...column, period: tableMode }));
      }
      break;
    }

    default:
      selected = [];
  }

  const filtered = selected.filter((column) => matchesDateFilters(column.reportPeriod, input));
  return filtered.slice(-input.limit);
}

function buildIncomeStatements(input: FinancialStatementsInput, tables: ScrapedTables): unknown[] {
  const table = input.period === 'quarterly'
    ? (tables['#quarters'] ?? tables['#profit-loss'])
    : tables['#profit-loss'];
  if (!table) return [];

  const columns = selectColumns(
    table.headers,
    input,
    input.period === 'quarterly' && table.selector === '#quarters' ? 'quarterly' : 'annual',
  );
  return normalizeStatementRows(columns.map((column) => {
    const lookup = buildMetricLookup(table, column.index);

    return {
      report_period: column.reportPeriod ?? column.header,
      period: column.period,
      revenue: readMetricValue(lookup, ['sales'], parseCroreCell),
      operating_expenses: readMetricValue(lookup, ['expenses'], parseCroreCell),
      operating_income: readMetricValue(lookup, ['operating profit'], parseCroreCell),
      operating_margin: readMetricValue(lookup, ['opm %'], parsePercentCell),
      other_income: readMetricValue(lookup, ['other income'], parseCroreCell),
      interest_expense: readMetricValue(lookup, ['interest'], parseCroreCell),
      depreciation_and_amortization: readMetricValue(lookup, ['depreciation'], parseCroreCell),
      income_before_tax: readMetricValue(lookup, ['profit before tax'], parseCroreCell),
      income_tax_rate: readMetricValue(lookup, ['tax %'], parsePercentCell),
      net_income: readMetricValue(lookup, ['net profit'], parseCroreCell),
      earnings_per_share: readMetricValue(lookup, ['eps in rs'], parsePlainNumberCell),
      dividend_payout_ratio: readMetricValue(lookup, ['dividend payout %'], parsePercentCell),
    };
  }));
}

function buildBalanceSheets(input: FinancialStatementsInput, tables: ScrapedTables): unknown[] {
  const table = tables['#balance-sheet'];
  if (!table) return [];

  const columns = selectColumns(table.headers, input, 'annual');
  return normalizeStatementRows(columns.map((column) => {
    const lookup = buildMetricLookup(table, column.index);
    const equityCapital = readMetricValue(lookup, ['equity capital'], parseCroreCell);
    const reserves = readMetricValue(lookup, ['reserves'], parseCroreCell);
    const borrowings = readMetricValue(lookup, ['borrowings'], parseCroreCell);
    const otherLiabilities = readMetricValue(lookup, ['other liabilities'], parseCroreCell);
    const reportedTotalLiabilities = readMetricValue(lookup, ['total liabilities'], parseCroreCell);
    const shareholdersEquity = sumNullable(equityCapital, reserves);

    return {
      report_period: column.reportPeriod ?? column.header,
      period: column.period,
      equity_capital: equityCapital,
      reserves,
      total_debt: borrowings,
      borrowings,
      other_liabilities: otherLiabilities,
      shareholders_equity: shareholdersEquity,
      total_equity: shareholdersEquity,
      total_liabilities: sumNullable(borrowings, otherLiabilities) ?? reportedTotalLiabilities,
      reported_total_liabilities: reportedTotalLiabilities,
      fixed_assets: readMetricValue(lookup, ['fixed assets'], parseCroreCell),
      capital_work_in_progress: readMetricValue(lookup, ['cwip'], parseCroreCell),
      investments: readMetricValue(lookup, ['investments'], parseCroreCell),
      other_assets: readMetricValue(lookup, ['other assets'], parseCroreCell),
      cash_and_equivalents: readMetricValue(
        lookup,
        ['cash and equivalents', 'cash equivalents', 'cash & equivalents'],
        parseCroreCell,
      ),
      total_assets: readMetricValue(lookup, ['total assets'], parseCroreCell),
    };
  }));
}

function buildCashFlowStatements(input: FinancialStatementsInput, tables: ScrapedTables): unknown[] {
  const table = tables['#cash-flow'];
  if (!table) return [];

  const columns = selectColumns(table.headers, input, 'annual');
  return normalizeStatementRows(columns.map((column) => {
    const lookup = buildMetricLookup(table, column.index);
    const operatingCashFlow = readMetricValue(
      lookup,
      ['cash from operating activity'],
      parseCroreCell,
    );
    const freeCashFlow = readMetricValue(lookup, ['free cash flow'], parseCroreCell);
    const explicitCapex = readMetricValue(
      lookup,
      ['capex', 'capital expenditure', 'capital expenditures'],
      parseCroreCell,
    );
    const derivedCapex = operatingCashFlow !== null && freeCashFlow !== null
      ? operatingCashFlow - freeCashFlow
      : null;

    return {
      report_period: column.reportPeriod ?? column.header,
      period: column.period,
      operating_cash_flow: operatingCashFlow,
      net_cash_flow_from_operations: operatingCashFlow,
      investing_cash_flow: readMetricValue(
        lookup,
        ['cash from investing activity'],
        parseCroreCell,
      ),
      financing_cash_flow: readMetricValue(
        lookup,
        ['cash from financing activity'],
        parseCroreCell,
      ),
      net_change_in_cash: readMetricValue(lookup, ['net cash flow'], parseCroreCell),
      free_cash_flow: freeCashFlow,
      capital_expenditure: explicitCapex ?? derivedCapex,
      cfo_to_op_profit_ratio: readMetricValue(lookup, ['cfo/op'], parsePercentCell),
    };
  }));
}

async function fetchFundamentals(
  kind: StatementKind,
  input: FinancialStatementsInput,
): Promise<{ data: unknown; url: string }> {
  const normalizedTicker = normalizeIndianTicker(input.ticker);
  const url = buildScreenerCompanyUrl(normalizedTicker);
  const page = await ensureBrowser();

  try {
    await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });

    const { tables: extractedTables } = await extractTablesFromPage(page, [...SCREENER_TABLE_SELECTORS]);
    const tables = extractedTables
      .filter(isBrowserTable)
      .reduce<ScrapedTables>((acc, table) => {
        acc[table.selector] = table;
        return acc;
      }, {});

    if (Object.keys(tables).length === 0) {
      const pageTitle = await page.title().catch(() => '');
      throw new Error(
        `Screener table extraction returned no tables${pageTitle ? ` for page "${pageTitle}"` : ''}`,
      );
    }

    const combined = normalizeCombinedStatements({
      income_statements: buildIncomeStatements(input, tables),
      balance_sheets: buildBalanceSheets(input, tables),
      cash_flow_statements: buildCashFlowStatements(input, tables),
    });

    switch (kind) {
      case 'income':
        return { data: combined.income_statements, url: page.url() };
      case 'balance':
        return { data: combined.balance_sheets, url: page.url() };
      case 'cashflow':
        return { data: combined.cash_flow_statements, url: page.url() };
      case 'all':
        return { data: combined, url: page.url() };
    }
  } finally {
    await closeBrowser().catch(() => undefined);
  }
}

export const getIncomeStatements = new DynamicStructuredTool({
  name: 'get_income_statements',
  description: `Fetches a company's income statements, detailing its revenues, expenses, net income, etc. over a reporting period. Useful for evaluating a company's profitability and operational efficiency.`,
  schema: FinancialStatementsInputSchema,
  func: async (input) => {
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
    const { data, url } = await fetchFundamentals('cashflow', input);
    return formatToolResult(
      stripFieldsDeep(data || {}, REDUNDANT_FINANCIAL_FIELDS),
      [url]
    );
  },
});

export const getAllFinancialStatements = new DynamicStructuredTool({
  name: 'get_all_financial_statements',
  description: `Retrieves all three financial statements (income statements, balance sheets, and cash flow statements) for a company in a single call. This is more efficient than calling each statement type separately when you need all three for comprehensive financial analysis.`,
  schema: FinancialStatementsInputSchema,
  func: async (input) => {
    const { data, url } = await fetchFundamentals('all', input);
    return formatToolResult(
      stripFieldsDeep(data || {}, REDUNDANT_FINANCIAL_FIELDS),
      [url]
    );
  },
});
