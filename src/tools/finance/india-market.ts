export const INDIA_TIMEZONE = 'Asia/Kolkata';
export const INDIA_DEFAULT_CURRENCY = 'INR';
export const INDIA_DEFAULT_PRIMARY_EXCHANGE = 'NSE';
export const INDIA_MARKET_HOURS = {
  start: '09:15',
  end: '15:30',
  timezone: INDIA_TIMEZONE,
  daysOfWeek: [1, 2, 3, 4, 5],
} as const;

export const INDIA_DISCLOSURE_DOMAINS = ['nseindia.com', 'bseindia.com', 'sebi.gov.in'] as const;

export const INDIA_DISCLOSURE_TYPES = [
  'financial-results',
  'annual-report',
  'shareholding-pattern',
  'corporate-announcement',
  'board-meeting',
  'investor-presentation',
  'concall-transcript',
  'insider-disclosure',
] as const;

export type IndiaDisclosureType = typeof INDIA_DISCLOSURE_TYPES[number];

const NSE_PAGE_BY_DISCLOSURE: Partial<Record<IndiaDisclosureType, string>> = {
  'financial-results': 'https://www.nseindia.com/companies-listing/corporate-filings-financial-results',
  'annual-report': 'https://www.nseindia.com/companies-listing/corporate-filings-annual-reports',
  'shareholding-pattern': 'https://www.nseindia.com/companies-listing/corporate-filings-shareholding-pattern',
};

const DISCLOSURE_QUERY_HINTS: Record<IndiaDisclosureType, string[]> = {
  'financial-results': ['quarterly results', 'financial results', 'integrated filing financials'],
  'annual-report': ['annual report'],
  'shareholding-pattern': ['shareholding pattern', 'promoter holding'],
  'corporate-announcement': ['corporate announcement', 'company announcement'],
  'board-meeting': ['board meeting', 'outcome of board meeting'],
  'investor-presentation': ['investor presentation', 'earnings presentation'],
  'concall-transcript': ['concall transcript', 'earnings call transcript'],
  'insider-disclosure': ['insider trading disclosure', 'SEBI PIT disclosure'],
};

export function describeIndianTickerFormat(): string {
  return "Use Indian market identifiers such as 'RELIANCE.NSE', 'INFY.NSE', 'TCS.BSE', or 'MCX:GOLDPETAL'. If the exchange is omitted, default to NSE cash market.";
}

export function normalizeIndianTicker(input: string): string {
  const trimmed = input.trim().toUpperCase();
  if (!trimmed) return trimmed;

  if (trimmed.includes('|')) {
    return trimmed;
  }

  if (trimmed.startsWith('NSE:') || trimmed.startsWith('BSE:') || trimmed.startsWith('MCX:')) {
    const [exchange, symbol] = trimmed.split(':', 2);
    return `${symbol}.${exchange}`;
  }

  if (trimmed.endsWith('.NS')) return `${trimmed.slice(0, -3)}.NSE`;
  if (trimmed.endsWith('.BO')) return `${trimmed.slice(0, -3)}.BSE`;

  if (trimmed.endsWith('.NSE') || trimmed.endsWith('.BSE') || trimmed.endsWith('.MCX')) {
    return trimmed;
  }

  return `${trimmed}.${INDIA_DEFAULT_PRIMARY_EXCHANGE}`;
}

export function getTickerSymbol(input: string): string {
  const normalized = normalizeIndianTicker(input);
  if (normalized.includes('.')) {
    return normalized.split('.', 1)[0];
  }
  return normalized;
}

export function getTickerExchange(input: string): string {
  const normalized = normalizeIndianTicker(input);
  if (normalized.includes('.')) {
    return normalized.split('.').at(-1) ?? INDIA_DEFAULT_PRIMARY_EXCHANGE;
  }
  return INDIA_DEFAULT_PRIMARY_EXCHANGE;
}

export function buildIndiaDisclosureQueries(params: {
  companyOrSymbol: string;
  disclosureTypes: IndiaDisclosureType[];
}): string[] {
  const { companyOrSymbol, disclosureTypes } = params;
  const normalizedTypes: IndiaDisclosureType[] = disclosureTypes.length > 0
    ? disclosureTypes
    : ['corporate-announcement'];

  return normalizedTypes.map((type) => {
    const hints = DISCLOSURE_QUERY_HINTS[type].join(' OR ');
    return `${companyOrSymbol} (${hints}) site:nseindia.com OR site:bseindia.com OR site:sebi.gov.in`;
  });
}

export function buildCanonicalDisclosureUrls(input: string): string[] {
  const symbol = getTickerSymbol(input);
  const urls = Object.values(NSE_PAGE_BY_DISCLOSURE).map((url) => `${url}?symbol=${symbol}&tabIndex=equity`);
  urls.push(`https://www.bseindia.com/stock-share-price/${symbol}/`);
  return urls;
}

export function isProtectedIndianDisclosureDomain(url: string): boolean {
  return url.includes('nseindia.com') || url.includes('bseindia.com');
}
