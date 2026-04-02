import 'dotenv/config';
import { buildUpstoxAuthorizeUrl, formatUpstoxAuthInstructions, hasUpstoxCredentials } from '../src/tools/finance/upstox.js';

if (!hasUpstoxCredentials()) {
  console.error('Missing UPSTOX_API_KEY, UPSTOX_API_SECRET, or UPSTOX_REDIRECT_URI in .env');
  process.exit(1);
}

console.log('Open this URL in your browser to authorize Dexter with Upstox:\n');
console.log(buildUpstoxAuthorizeUrl());
console.log('\nNext:\n');
console.log(formatUpstoxAuthInstructions());
