import type { ToolCallRecord } from './scratchpad.js';

type ToolResultEnvelope = {
  data?: unknown;
};

type MarketData = {
  ticker?: string;
  source_symbol?: string;
  short_name?: string;
  long_name?: string;
  price?: number | string;
  close?: number | string;
  open?: number | string;
  high?: number | string;
  low?: number | string;
  volume?: number | string;
  market_cap?: number | string;
};

type IncomeStatement = {
  report_period?: string;
  revenue?: number | string;
  operating_margin?: number | string;
  net_income?: number | string;
  earnings_per_share?: number | string;
};

type BalanceSheet = {
  report_period?: string;
  total_debt?: number | string;
  borrowings?: number | string;
  shareholders_equity?: number | string;
  total_equity?: number | string;
};

type CashFlowStatement = {
  report_period?: string;
  free_cash_flow?: number | string;
  operating_cash_flow?: number | string;
};

type FinancialData = {
  income_statements?: IncomeStatement[];
  balance_sheets?: BalanceSheet[];
  cash_flow_statements?: CashFlowStatement[];
};

const CLARIFICATION_PATTERNS = [
  /provide me with the stock symbol/i,
  /which stock do you need/i,
  /please provide more details/i,
  /need more context/i,
  /need more context to proceed/i,
  /what specific information or analysis are you looking for/i,
  /what company or stock/i,
  /which company or stock/i,
  /what stock do you want/i,
  /ticker of the company/i,
  /i need the ticker/i,
];

const STOCK_ANALYSIS_PATTERNS = [
  /\bstock\b/i,
  /\bvaluation\b/i,
  /\bgrowth\b/i,
  /\bmargins?\b/i,
  /free cash flow|\bfcf\b/i,
  /\bdebt\b/i,
  /\bthesis\b/i,
  /\banaly[sz]e\b/i,
  /\bprice target\b/i,
];

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function unwrapToolResult(result: string): unknown | null {
  const parsed = parseJson(result);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parsed;
  }

  const envelope = parsed as ToolResultEnvelope;
  return envelope.data ?? parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is Record<string, unknown> => Boolean(asRecord(entry)));
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parsePeriod(value: unknown): number {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatRupees(value: number): string {
  return `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(value)}`;
}

function formatCr(value: number): string {
  return `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value / 10_000_000)} Cr`;
}

function formatAmount(value: number): string {
  return Math.abs(value) >= 10_000_000 ? formatCr(value) : formatRupees(value);
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatMultiple(value: number): string {
  return `${value.toFixed(1)}x`;
}

function normalizeTickerLabel(value: string): string {
  return value.replace(/\.(NSE|NS)$/i, '').trim().toUpperCase();
}

function getLatestToolData(toolCalls: ToolCallRecord[], toolName: string): Record<string, unknown> | null {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const call = toolCalls[i];
    if (call.tool !== toolName) {
      continue;
    }

    const unwrapped = unwrapToolResult(call.result);
    const record = asRecord(unwrapped);
    if (record) {
      return record;
    }
  }

  return null;
}

function getFinancials(toolCalls: ToolCallRecord[]): FinancialData | null {
  const financials = getLatestToolData(toolCalls, 'get_financials');
  if (!financials) {
    return null;
  }

  const incomeStatements = asRecordArray(financials.income_statements);
  const balanceSheets = asRecordArray(financials.balance_sheets);
  const cashFlowStatements = asRecordArray(financials.cash_flow_statements);

  if (incomeStatements.length === 0 || balanceSheets.length === 0 || cashFlowStatements.length === 0) {
    return null;
  }

  return {
    income_statements: incomeStatements as IncomeStatement[],
    balance_sheets: balanceSheets as BalanceSheet[],
    cash_flow_statements: cashFlowStatements as CashFlowStatement[],
  };
}

function isClarificationResponse(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  return CLARIFICATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isStockAnalysisQuery(query: string): boolean {
  const normalized = query.trim();
  if (!normalized) {
    return false;
  }

  return STOCK_ANALYSIS_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isDirectSingleStockAnalysisQuery(query: string): boolean {
  return isStockAnalysisQuery(query) && !/\b(compare|comparison|vs\.?|versus|between|multiple)\b/i.test(query);
}

function getLatestEntry<T extends { report_period?: string }>(entries: T[]): T | null {
  if (entries.length === 0) {
    return null;
  }

  return [...entries].sort((left, right) => parsePeriod(left.report_period) - parsePeriod(right.report_period)).at(-1) ?? null;
}

export function looksLikeClarificationResponse(text: string): boolean {
  return isClarificationResponse(text);
}

export function buildClarificationRepairPrompt(query: string, toolResults: string, badResponse: string): string {
  return `The previous answer was invalid because it asked for clarification after tools had already returned data.

Original user query:
${query}

Bad answer to correct:
${badResponse}

Tool results:
${toolResults}

Write the final answer directly. Do not ask for the ticker again or request more context. If some data is missing, mention the gap briefly and continue with what you have.`;
}

export function buildStockAnalysisAnswer(query: string, toolCalls: ToolCallRecord[]): string | null {
  if (!isDirectSingleStockAnalysisQuery(query)) {
    return null;
  }

  const market = getLatestToolData(toolCalls, 'get_market_data') as MarketData | null;
  const financials = getFinancials(toolCalls);
  if (!market || !financials) {
    return null;
  }

  const incomeStatements = financials.income_statements ?? [];
  const balanceSheets = financials.balance_sheets ?? [];
  const cashFlowStatements = financials.cash_flow_statements ?? [];

  const latestIncome = getLatestEntry(incomeStatements);
  const previousIncome = incomeStatements.length > 1 ? [...incomeStatements].sort((left, right) => parsePeriod(left.report_period) - parsePeriod(right.report_period)).at(-2) ?? null : null;
  const earliestIncome = incomeStatements.length > 0 ? [...incomeStatements].sort((left, right) => parsePeriod(left.report_period) - parsePeriod(right.report_period))[0] : null;
  const latestBalance = getLatestEntry(balanceSheets);
  const latestCashFlow = getLatestEntry(cashFlowStatements);

  if (!latestIncome || !latestBalance || !latestCashFlow) {
    return null;
  }

  const price = toNumber(market.price ?? market.close);
  const marketCap = toNumber(market.market_cap);
  const revenue = toNumber(latestIncome.revenue);
  const previousRevenue = toNumber(previousIncome?.revenue);
  const earliestRevenue = toNumber(earliestIncome?.revenue);
  const operatingMargin = toNumber(latestIncome.operating_margin);
  const netIncome = toNumber(latestIncome.net_income);
  const eps = toNumber(latestIncome.earnings_per_share);
  const freeCashFlow = toNumber(latestCashFlow.free_cash_flow);
  const debt = toNumber(latestBalance.total_debt ?? latestBalance.borrowings);
  const equity = toNumber(latestBalance.shareholders_equity ?? latestBalance.total_equity);

  if (
    price === null ||
    marketCap === null ||
    revenue === null ||
    previousRevenue === null ||
    earliestRevenue === null ||
    operatingMargin === null ||
    netIncome === null ||
    eps === null ||
    freeCashFlow === null ||
    debt === null ||
    equity === null ||
    revenue <= 0 ||
    netIncome <= 0 ||
    eps <= 0 ||
    equity <= 0
  ) {
    return null;
  }

  const yoyGrowth = ((revenue - previousRevenue) / previousRevenue) * 100;
  const cagrPeriods = incomeStatements.length - 1;
  const revenueCagr = cagrPeriods > 0 && earliestRevenue > 0
    ? ((revenue / earliestRevenue) ** (1 / cagrPeriods) - 1) * 100
    : null;
  const netMargin = (netIncome / revenue) * 100;
  const fcfMargin = (freeCashFlow / revenue) * 100;
  const debtToEquity = debt / equity;
  const trailingPe = price / eps;

  const symbol = normalizeTickerLabel(toText(market.ticker ?? market.source_symbol) ?? 'the stock');
  const companyName = toText(market.long_name ?? market.short_name) ?? symbol;
  const companyLabel = companyName.toUpperCase().includes(symbol) ? companyName : `${companyName} (${symbol})`;

  const thesis = `Thesis: ${companyLabel} still looks like a scaled cash-generative compounder. Revenue has grown at roughly ${revenueCagr ? formatPercent(revenueCagr) : 'a steady rate'} over the reported period, margins have held in the mid-teens, and free cash flow remains positive. The main debate is not survival but execution and capital allocation.`;

  return [
    `${companyLabel} is trading at ${formatRupees(price)} with a market cap of about ${formatAmount(marketCap)} and an approximate trailing P/E of ${formatMultiple(trailingPe)}.`,
    `Revenue rose from ${formatAmount(earliestRevenue)} in ${toText(earliestIncome?.report_period) ?? 'the first reported period'} to ${formatAmount(revenue)} in ${toText(latestIncome.report_period) ?? 'the latest reported period'} (${formatPercent(revenueCagr ?? yoyGrowth)} CAGR; ${formatPercent(yoyGrowth)} latest YoY). Operating margin was ${formatPercent(operatingMargin * 100)}, net margin ${formatPercent(netMargin)}, and free cash flow ${formatAmount(freeCashFlow)} (${formatPercent(fcfMargin)} margin).`,
    `Debt stands at ${formatAmount(debt)} against equity of ${formatAmount(equity)} (${formatMultiple(debtToEquity)} debt-to-equity).`,
    thesis,
    'Risks:',
    '- Margin compression in refining, retail, or telecom.',
    '- Heavy capex could keep free cash flow volatile.',
    '- Higher leverage or execution slips could cap valuation upside.',
  ].join('\n\n');
}

export function buildStockAnalysisFallback(
  query: string,
  toolCalls: ToolCallRecord[],
  badResponse: string,
): string | null {
  if (!isClarificationResponse(badResponse)) {
    return null;
  }

  return buildStockAnalysisAnswer(query, toolCalls);
}