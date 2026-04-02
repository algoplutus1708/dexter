import 'dotenv/config';
import { exchangeUpstoxAuthCode, hasUpstoxCredentials } from '../src/tools/finance/upstox.js';
import { saveApiKeyToEnv } from '../src/utils/env.js';

function parseCodeFromArgs(): string | null {
  const args = process.argv.slice(2);
  const codeFlagIndex = args.findIndex((arg) => arg === '--code');
  if (codeFlagIndex >= 0 && args[codeFlagIndex + 1]) {
    return args[codeFlagIndex + 1]!;
  }

  const first = args[0];
  if (!first) return null;

  if (first.startsWith('http://') || first.startsWith('https://')) {
    const url = new URL(first);
    return url.searchParams.get('code');
  }

  return first;
}

async function main() {
  if (!hasUpstoxCredentials()) {
    console.error('Missing UPSTOX_API_KEY, UPSTOX_API_SECRET, or UPSTOX_REDIRECT_URI in .env');
    process.exit(1);
  }

  const code = parseCodeFromArgs();
  if (!code) {
    console.error('Usage: bun run upstox:token --code <auth_code>');
    console.error('You can also pass the full redirect URL instead of the raw code.');
    process.exit(1);
  }

  const tokenResponse = await exchangeUpstoxAuthCode(code);
  const accessToken = tokenResponse.access_token;
  if (!accessToken) {
    console.error('Upstox did not return an access token.');
    process.exit(1);
  }

  const saved = saveApiKeyToEnv('UPSTOX_ACCESS_TOKEN', accessToken);
  if (!saved) {
    console.error('Token exchange succeeded, but saving UPSTOX_ACCESS_TOKEN to .env failed.');
    process.exit(1);
  }

  console.log('Saved UPSTOX_ACCESS_TOKEN to .env');
  if (tokenResponse.user_id) {
    console.log(`User: ${tokenResponse.user_id}`);
  }
  if (tokenResponse.email) {
    console.log(`Email: ${tokenResponse.email}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
