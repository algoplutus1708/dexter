import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import {
  formatUpstoxAuthExpiredResult,
  getUpstoxOptionChain,
  getUpstoxOptionContracts,
  hasUpstoxAccessToken,
  UpstoxAuthExpiredError,
} from './upstox.js';

const OptionContractsInputSchema = z.object({
  underlying: z.string().describe('Underlying symbol or index, e.g. RELIANCE.NSE or NIFTY 50'),
  expiry_date: z.string().optional().describe('Optional expiry date in YYYY-MM-DD format'),
});

export const getOptionContracts = new DynamicStructuredTool({
  name: 'get_option_contracts',
  description: 'Retrieve available NSE option contracts for a stock or index underlying, including strikes, expiries, and contract metadata.',
  schema: OptionContractsInputSchema,
  func: async (input) => {
    if (!hasUpstoxAccessToken()) {
      return formatToolResult({
        error: 'UPSTOX_ACCESS_TOKEN is required for option contract discovery.',
        next_step: 'Complete the Upstox OAuth flow and save the access token in .env.',
      }, []);
    }

    try {
      const { data, url } = await getUpstoxOptionContracts(input);
      return formatToolResult(data, [url]);
    } catch (error) {
      if (error instanceof UpstoxAuthExpiredError) {
        return formatUpstoxAuthExpiredResult();
      }
      throw error;
    }
  },
});

const OptionChainInputSchema = z.object({
  underlying: z.string().describe('Underlying symbol or index, e.g. RELIANCE.NSE or NIFTY 50'),
  expiry_date: z.string().describe('Expiry date in YYYY-MM-DD format'),
});

export const getOptionChain = new DynamicStructuredTool({
  name: 'get_option_chain',
  description: 'Retrieve NSE put/call option chain data for a stock or index underlying and a specific expiry.',
  schema: OptionChainInputSchema,
  func: async (input) => {
    if (!hasUpstoxAccessToken()) {
      return formatToolResult({
        error: 'UPSTOX_ACCESS_TOKEN is required for option chain data.',
        next_step: 'Complete the Upstox OAuth flow and save the access token in .env.',
      }, []);
    }

    try {
      const { data, url } = await getUpstoxOptionChain(input);
      return formatToolResult(data, [url]);
    } catch (error) {
      if (error instanceof UpstoxAuthExpiredError) {
        return formatUpstoxAuthExpiredResult();
      }
      throw error;
    }
  },
});
