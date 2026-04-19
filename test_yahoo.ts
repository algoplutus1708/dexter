import { getYahooIndiaQuote } from './src/tools/finance/yahoo-india.js';

async function test() {
  try {
    const res = await getYahooIndiaQuote("TATAMOTORS");
    console.log("Success:", res);
  } catch(e) {
    console.error("Error:", e);
  }
}
test();
