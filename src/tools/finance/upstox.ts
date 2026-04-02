import { formatToolResult } from '../types.js';
import { normalizeIndianTicker } from './india-market.js';

const UPSTOX_AUTH_URL = 'https://api.upstox.com/v2/login/authorization/dialog';
const UPSTOX_TOKEN_URL = 'https://api.upstox.com/v2/login/authorization/token';
const UPSTOX_LTP_URL = 'https://api.upstox.com/v2/market-quote/ltp';
const UPSTOX_OHLC_URL = 'https://api.upstox.com/v3/market-quote/ohlc';
const UPSTOX_HISTORY_URL = 'https://api.upstox.com/v3/historical-candle';
const UPSTOX_OPTION_CONTRACTS_URL = 'https://api.upstox.com/v2/option/contract';
const UPSTOX_OPTION_CHAIN_URL = 'https://api.upstox.com/v2/option/chain';

const NSE_INSTRUMENTS_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';
const BSE_INSTRUMENTS_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz';

export type UpstoxInstrument = {
  segment?: string;
  name?: string;
  exchange?: string;
  isin?: string;
  instrument_type?: string;
  instrument_key?: string;
  lot_size?: number;
  freeze_quantity?: number;
  exchange_token?: string;
  tick_size?: number;
  trading_symbol?: string;
  short_name?: string;
  security_type?: string;
  weekly?: boolean;
  expiry?: number | string;
  underlying_symbol?: string;
  underlying_key?: string;
  strike_price?: number;
  minimum_lot?: number;
  option_type?: string;
};

type UpstoxOhlcResponse = {
  data?: Record<string, {
    last_price?: number;
    instrument_token?: string;
    live_ohlc?: {
      open?: number;
      high?: number;
      low?: number;
      close?: number;
      volume?: number;
      ts?: number;
    };
    prev_ohlc?: {
      open?: number;
      high?: number;
      low?: number;
      close?: number;
      volume?: number;
      ts?: number;
    };
  }>;
};

type UpstoxHistoryResponse = {
  data?: {
    candles?: Array<[string, number, number, number, number, number, number?]>;
  };
};

type UpstoxLtpResponse = {
  data?: Record<string, {
    last_price?: number;
    instrument_token?: string;
  }>;
};

type UpstoxTokenResponse = {
  access_token?: string;
  user_id?: string;
  email?: string;
};

type UpstoxOptionContractsResponse = {
  data?: Array<Record<string, unknown>>;
};

type UpstoxOptionChainResponse = {
  data?: Array<Record<string, unknown>>;
};

const instrumentCache = new Map<string, UpstoxInstrument[]>();

export function hasUpstoxCredentials(): boolean {
  return Boolean(process.env.UPSTOX_API_KEY && process.env.UPSTOX_API_SECRET && process.env.UPSTOX_REDIRECT_URI);
}

export function hasUpstoxAccessToken(): boolean {
  return Boolean(process.env.UPSTOX_ACCESS_TOKEN);
}

function getUpstoxAccessToken(): string {
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  if (!token) {
    throw new Error('UPSTOX_ACCESS_TOKEN is not set. Complete the Upstox OAuth flow first.');
  }
  return token;
}

function getUpstoxApiKey(): string {
  const apiKey = process.env.UPSTOX_API_KEY;
  if (!apiKey) {
    throw new Error('UPSTOX_API_KEY is not set.');
  }
  return apiKey;
}

function getUpstoxApiSecret(): string {
  const secret = process.env.UPSTOX_API_SECRET;
  if (!secret) {
    throw new Error('UPSTOX_API_SECRET is not set.');
  }
  return secret;
}

function getUpstoxRedirectUri(): string {
  const redirectUri = process.env.UPSTOX_REDIRECT_URI;
  if (!redirectUri) {
    throw new Error('UPSTOX_REDIRECT_URI is not set.');
  }
  return redirectUri;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Upstox request failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`);
  }
  return response.json() as Promise<T>;
}

function upstoxHeaders(): HeadersInit {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${getUpstoxAccessToken()}`,
  };
}

export function buildUpstoxAuthorizeUrl(state = 'dexter'): string {
  const url = new URL(UPSTOX_AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', getUpstoxApiKey());
  url.searchParams.set('redirect_uri', getUpstoxRedirectUri());
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeUpstoxAuthCode(code: string): Promise<UpstoxTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: getUpstoxApiKey(),
    client_secret: getUpstoxApiSecret(),
    redirect_uri: getUpstoxRedirectUri(),
    grant_type: 'authorization_code',
  });

  const response = await fetch(UPSTOX_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Upstox token exchange failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`);
  }

  return response.json() as Promise<UpstoxTokenResponse>;
}

async function loadInstrumentUniverse(exchange: 'NSE' | 'BSE'): Promise<UpstoxInstrument[]> {
  if (instrumentCache.has(exchange)) {
    return instrumentCache.get(exchange)!;
  }

  const url = exchange === 'NSE' ? NSE_INSTRUMENTS_URL : BSE_INSTRUMENTS_URL;
  const data = await fetchJson<UpstoxInstrument[]>(url, {
    headers: { Accept: 'application/json' },
  });
  instrumentCache.set(exchange, data);
  return data;
}

function normalizeSearchToken(value: string): string {
  return value.replace(/\s+/g, '').replace(/[.&-]/g, '').toUpperCase();
}

function scoreInstrumentMatch(instrument: UpstoxInstrument, query: string): number {
  const q = normalizeSearchToken(query);
  const trading = normalizeSearchToken(instrument.trading_symbol ?? '');
  const shortName = normalizeSearchToken(instrument.short_name ?? '');
  const name = normalizeSearchToken(instrument.name ?? '');

  if (trading === q) return 100;
  if (shortName === q) return 95;
  if (name === q) return 90;
  if (trading.startsWith(q)) return 80;
  if (shortName.startsWith(q)) return 75;
  if (name.includes(q)) return 60;
  return 0;
}

export async function resolveUpstoxInstrument(input: string): Promise<UpstoxInstrument | null> {
  const normalized = normalizeIndianTicker(input);
  const [symbol, exchangeHint = 'NSE'] = normalized.split('.', 2);
  const searchValue = symbol === 'NIFTY 50' || symbol === 'NIFTY' ? 'Nifty 50'
    : symbol === 'NIFTY BANK' || symbol === 'BANKNIFTY' ? 'Nifty Bank'
    : symbol === 'SENSEX' ? 'SENSEX'
    : symbol;

  const exchanges: Array<'NSE' | 'BSE'> = exchangeHint === 'BSE' ? ['BSE', 'NSE'] : ['NSE', 'BSE'];

  for (const exchange of exchanges) {
    const instruments = await loadInstrumentUniverse(exchange);
    const best = instruments
      .map((instrument) => ({ instrument, score: scoreInstrumentMatch(instrument, searchValue) }))
      .filter((entry) => entry.score > 0 && entry.instrument.instrument_key)
      .sort((a, b) => b.score - a.score)[0];
    if (best) return best.instrument;
  }

  return null;
}

export async function searchUpstoxInstruments(query: string, limit = 10): Promise<UpstoxInstrument[]> {
  const [nse, bse] = await Promise.all([loadInstrumentUniverse('NSE'), loadInstrumentUniverse('BSE')]);
  return [...nse, ...bse]
    .map((instrument) => ({ instrument, score: scoreInstrumentMatch(instrument, query) }))
    .filter((entry) => entry.score > 0 && entry.instrument.instrument_key)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.instrument);
}

export async function getUpstoxQuote(input: string): Promise<{ data: Record<string, unknown>; url: string }> {
  const instrument = await resolveUpstoxInstrument(input);
  if (!instrument?.instrument_key) {
    throw new Error(`Unable to resolve Upstox instrument for ${input}`);
  }

  const url = `${UPSTOX_OHLC_URL}?instrument_key=${encodeURIComponent(instrument.instrument_key)}&interval=1d`;
  const response = await fetchJson<UpstoxOhlcResponse>(url, { headers: upstoxHeaders() });
  const entry = response.data?.[Object.keys(response.data ?? {})[0] ?? ''];
  if (!entry) {
    throw new Error(`Upstox quote unavailable for ${input}`);
  }

  return {
    url,
    data: {
      ticker: normalizeIndianTicker(input),
      instrument_key: instrument.instrument_key,
      source_symbol: instrument.trading_symbol ?? instrument.short_name ?? input,
      price: entry.last_price ?? entry.live_ohlc?.close,
      close: entry.live_ohlc?.close ?? entry.last_price,
      open: entry.live_ohlc?.open,
      high: entry.live_ohlc?.high,
      low: entry.live_ohlc?.low,
      volume: entry.live_ohlc?.volume,
      previous_close: entry.prev_ohlc?.close,
      exchange: instrument.exchange,
      market_cap: undefined,
    },
  };
}

export async function getUpstoxHistory(params: {
  ticker: string;
  interval: 'day' | 'week' | 'month' | 'year';
  start_date: string;
  end_date: string;
}): Promise<{ data: Record<string, unknown>[]; url: string }> {
  const instrument = await resolveUpstoxInstrument(params.ticker);
  if (!instrument?.instrument_key) {
    throw new Error(`Unable to resolve Upstox instrument for ${params.ticker}`);
  }

  const unit = params.interval === 'day' ? 'days' : params.interval === 'week' ? 'weeks' : 'months';
  const interval = '1';
  const url = `${UPSTOX_HISTORY_URL}/${encodeURIComponent(instrument.instrument_key)}/${unit}/${interval}/${params.end_date}/${params.start_date}`;
  const response = await fetchJson<UpstoxHistoryResponse>(url, { headers: upstoxHeaders() });
  const rows = (response.data?.candles ?? []).map((candle) => ({
    ticker: normalizeIndianTicker(params.ticker),
    date: candle[0].slice(0, 10),
    open: candle[1],
    high: candle[2],
    low: candle[3],
    close: candle[4],
    volume: candle[5],
    open_interest: candle[6],
  }));

  return { url, data: rows };
}

function isLikelyIndexUnderlying(input: string): boolean {
  const normalized = normalizeIndianTicker(input);
  return normalized.startsWith('NIFTY') || normalized.startsWith('BANKNIFTY') || normalized.startsWith('SENSEX');
}

export async function getUpstoxOptionContracts(params: {
  underlying: string;
  expiry_date?: string;
}): Promise<{ data: Record<string, unknown>[]; url: string }> {
  const instrument = await resolveUpstoxInstrument(params.underlying);
  if (!instrument?.instrument_key) {
    throw new Error(`Unable to resolve underlying instrument for ${params.underlying}`);
  }

  const url = new URL(UPSTOX_OPTION_CONTRACTS_URL);
  url.searchParams.set('instrument_key', instrument.instrument_key);
  if (params.expiry_date) url.searchParams.set('expiry_date', params.expiry_date);

  const response = await fetchJson<UpstoxOptionContractsResponse>(url.toString(), { headers: upstoxHeaders() });
  return { url: url.toString(), data: response.data ?? [] };
}

export async function getUpstoxOptionChain(params: {
  underlying: string;
  expiry_date: string;
}): Promise<{ data: Record<string, unknown>[]; url: string }> {
  const instrument = await resolveUpstoxInstrument(params.underlying);
  if (!instrument?.instrument_key) {
    throw new Error(`Unable to resolve underlying instrument for ${params.underlying}`);
  }

  const fallbackUnderlyingKey = isLikelyIndexUnderlying(params.underlying)
    ? (instrument.instrument_key.includes('INDEX') ? instrument.instrument_key : `NSE_INDEX|Nifty 50`)
    : instrument.instrument_key;

  const url = new URL(UPSTOX_OPTION_CHAIN_URL);
  url.searchParams.set('instrument_key', fallbackUnderlyingKey);
  url.searchParams.set('expiry_date', params.expiry_date);

  const response = await fetchJson<UpstoxOptionChainResponse>(url.toString(), { headers: upstoxHeaders() });
  return { url: url.toString(), data: response.data ?? [] };
}

export function formatUpstoxAuthInstructions(): string {
  return [
    '1. Run the auth URL helper to print the Upstox login URL.',
    '2. Open that URL in your browser and approve the app.',
    '3. Copy the `code` query parameter from the redirect URL.',
    '4. Run the token exchange helper with that code to save UPSTOX_ACCESS_TOKEN into .env.',
  ].join('\n');
}

export function formatUpstoxMissingTokenResult(): string {
  return formatToolResult({
    error: 'Upstox access token is missing.',
    details: formatUpstoxAuthInstructions(),
  }, []);
}
