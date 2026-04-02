import { INDIA_DEFAULT_PRIMARY_EXCHANGE, normalizeIndianTicker } from './india-market.js';

type QuoteResponse = {
  quoteResponse?: {
    result?: Array<Record<string, unknown>>;
  };
};

type ChartResponse = {
  chart?: {
    result?: Array<{
      meta?: Record<string, unknown>;
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
    error?: unknown;
  };
};

const INDEX_MAP: Record<string, string> = {
  'NIFTY': '^NSEI',
  'NIFTY 50': '^NSEI',
  '^NSEI': '^NSEI',
  'BANKNIFTY': '^NSEBANK',
  'NIFTY BANK': '^NSEBANK',
  '^NSEBANK': '^NSEBANK',
  'SENSEX': '^BSESN',
  '^BSESN': '^BSESN',
};

type YahooSession = {
  crumb: string;
  cookie: string;
  fetchedAtMs: number;
};

let yahooSession: YahooSession | null = null;
const YAHOO_SESSION_TTL_MS = 30 * 60 * 1000;

function lastDefined<T>(values: Array<T | null | undefined> | undefined): T | undefined {
  if (!values) return undefined;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i];
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function hasStructuredFinanceProvider(): boolean {
  return Boolean(
    process.env.FINANCE_API_BASE_URL ||
    process.env.INDIA_MARKET_API_BASE_URL ||
    process.env.INDIA_MARKET_API_KEY ||
    process.env.FINANCIAL_DATASETS_API_KEY,
  );
}

export function toYahooSymbol(input: string): string {
  const trimmed = input.trim().toUpperCase();
  if (INDEX_MAP[trimmed]) return INDEX_MAP[trimmed];

  const normalized = normalizeIndianTicker(trimmed);
  if (normalized.includes('.')) {
    const [symbol, exchange] = normalized.split('.', 2);
    if (exchange === 'NSE') return `${symbol}.NS`;
    if (exchange === 'BSE') return `${symbol}.BO`;
    return symbol;
  }

  return `${normalized}.${INDIA_DEFAULT_PRIMARY_EXCHANGE === 'NSE' ? 'NS' : 'BO'}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const session = await getYahooSession();
  const requestUrl = new URL(url);
  if (!requestUrl.searchParams.has('crumb')) {
    requestUrl.searchParams.set('crumb', session.crumb);
  }

  const response = await fetch(requestUrl.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/json',
      Cookie: session.cookie,
    },
  });

  if (!response.ok) {
    throw new Error(`Yahoo Finance request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

function extractCookieFromResponse(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('Yahoo Finance session cookie not found');
  }

  return setCookie
    .split(/,(?=[^;]+=[^;]+)/)
    .map((part) => part.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

async function getYahooSession(): Promise<YahooSession> {
  if (yahooSession && Date.now() - yahooSession.fetchedAtMs < YAHOO_SESSION_TTL_MS) {
    return yahooSession;
  }

  const homepage = await fetch('https://finance.yahoo.com/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!homepage.ok) {
    throw new Error(`Yahoo Finance session bootstrap failed: ${homepage.status} ${homepage.statusText}`);
  }

  const cookie = extractCookieFromResponse(homepage);
  const crumbResponse = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'text/plain,*/*',
      Cookie: cookie,
    },
  });

  if (!crumbResponse.ok) {
    throw new Error(`Yahoo Finance crumb bootstrap failed: ${crumbResponse.status} ${crumbResponse.statusText}`);
  }

  const crumb = (await crumbResponse.text()).trim();
  if (!crumb) {
    throw new Error('Yahoo Finance crumb was empty');
  }

  yahooSession = { crumb, cookie, fetchedAtMs: Date.now() };
  return yahooSession;
}

export async function getYahooIndiaQuote(input: string): Promise<{ data: Record<string, unknown>; url: string }> {
  const symbol = toYahooSymbol(input);
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const data = await fetchJson<QuoteResponse>(url);
  const quote = data.quoteResponse?.result?.[0];

  if (!quote) {
    throw new Error(`No public Yahoo Finance quote found for ${input}`);
  }

  return {
    url,
    data: {
      ticker: normalizeIndianTicker(input),
      source_symbol: symbol,
      price: quote.regularMarketPrice,
      close: quote.regularMarketPrice,
      open: quote.regularMarketOpen,
      high: quote.regularMarketDayHigh,
      low: quote.regularMarketDayLow,
      volume: quote.regularMarketVolume,
      market_cap: quote.marketCap,
      exchange: quote.fullExchangeName ?? quote.exchange,
      currency: quote.currency ?? 'INR',
      short_name: quote.shortName,
      long_name: quote.longName,
    },
  };
}

export async function getYahooIndiaHistory(params: {
  ticker: string;
  interval: 'day' | 'week' | 'month' | 'year';
  start_date: string;
  end_date: string;
}): Promise<{ data: Record<string, unknown>[]; url: string }> {
  const symbol = toYahooSymbol(params.ticker);
  const intervalMap = {
    day: '1d',
    week: '1wk',
    month: '1mo',
    year: '3mo',
  } as const;

  const period1 = Math.floor(new Date(`${params.start_date}T00:00:00Z`).getTime() / 1000);
  const period2 = Math.floor(new Date(`${params.end_date}T23:59:59Z`).getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=${intervalMap[params.interval]}&includePrePost=false&events=div,splits`;
  const data = await fetchJson<ChartResponse>(url);
  const result = data.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];

  if (!result || !quote) {
    throw new Error(`No public Yahoo Finance history found for ${params.ticker}`);
  }

  const rows = timestamps.map((timestamp, index) => ({
    ticker: normalizeIndianTicker(params.ticker),
    date: new Date(timestamp * 1000).toISOString().slice(0, 10),
    open: quote.open?.[index] ?? null,
    high: quote.high?.[index] ?? null,
    low: quote.low?.[index] ?? null,
    close: quote.close?.[index] ?? null,
    volume: quote.volume?.[index] ?? null,
  })).filter((row) => row.close !== null);

  return { url, data: rows };
}

export async function getYahooIndiaSnapshotFromChart(input: string): Promise<{ data: Record<string, unknown>; url: string }> {
  const symbol = toYahooSymbol(input);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d&includePrePost=false&events=div,splits`;
  const data = await fetchJson<ChartResponse>(url);
  const result = data.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const meta = result?.meta ?? {};

  if (!result || !quote) {
    throw new Error(`No public Yahoo Finance chart found for ${input}`);
  }

  return {
    url,
    data: {
      ticker: normalizeIndianTicker(input),
      source_symbol: symbol,
      price: meta.regularMarketPrice ?? lastDefined(quote.close),
      close: meta.regularMarketPrice ?? lastDefined(quote.close),
      open: meta.regularMarketOpen ?? lastDefined(quote.open),
      high: meta.regularMarketDayHigh ?? lastDefined(quote.high),
      low: meta.regularMarketDayLow ?? lastDefined(quote.low),
      volume: meta.regularMarketVolume ?? lastDefined(quote.volume),
      exchange: meta.exchangeName,
      currency: meta.currency ?? 'INR',
    },
  };
}
