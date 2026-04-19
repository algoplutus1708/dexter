import { getYahooIndiaSnapshotFromChart } from './src/tools/finance/yahoo-india.js';

async function test() {
  try {
    const res = await getYahooIndiaSnapshotFromChart("TATAMOTORS");
    console.log("Success:", res);
  } catch(e) {
    console.error("Error:", e);
  }
}
test();
