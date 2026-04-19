import { fetch } from 'bun';

async function testScreener() {
  const url = 'https://query1.finance.yahoo.com/v1/finance/screener';
  const body = {
    size: 25,
    offset: 0,
    sortField: "intradaymarketcap",
    sortType: "DESC",
    quoteType: "EQUITY",
    query: {
      operator: "AND",
      operands: [
        {
          operator: "eq",
          operands: ["region", "in"]
        },
        {
          operator: "gt",
          operands: ["forwardpe", 0]
        },
        {
          operator: "lt",
          operands: ["forwardpe", 25]
        }
      ]
    }
  };
  
  try {
    const res = await fetch(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
      }
    });
    console.log(res.status);
    const data = await res.json();
    console.log(JSON.stringify(data.finance?.result?.[0]?.quotes?.slice(0, 5).map(q => q.symbol), null, 2));
  } catch (e) {
    console.error(e);
  }
}

testScreener();
