import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, AIMessage, ToolMessage, SystemMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

async function test() {
  const model = new ChatOpenAI({
    model: "qwen2.5:14b",
    apiKey: "ollama",
    configuration: {
      baseURL: "http://127.0.0.1:11434/v1" // use Ollama's OpenAI compat API
    }
  });

  const tool = new DynamicStructuredTool({
    name: 'get_market_data',
    description: 'Fetches live Indian stock price. Pass only the ticker symbol (e.g. RELIANCE, TATAMOTORS).',
    schema: z.object({
      ticker: z.string()
    }),
    func: async (input) => {
      return JSON.stringify({ price: 1000, ticker: input.ticker });
    }
  });

  const modelWithTools = model.bindTools([tool]);

  console.log("--- Turn 1: User asks for TAATMOTORS ---");
  const messages = [
    new SystemMessage("You are a financial agent. Answer truthfully. Do NOT ask for clarification. If you have the data, display it."),
    new HumanMessage("Get me the current stock price for TATAMOTORS.")
  ];
  
  let res = await modelWithTools.invoke(messages);
  console.log("Turn 1 AI response:", res);
  // @ts-ignore
  messages.push(res);

  if (res.tool_calls && res.tool_calls.length > 0) {
    console.log("\n--- Executing Tool ---");
    const tc = res.tool_calls[0];
    const toolMsg = new ToolMessage({
      content: JSON.stringify({ price: 1045.20, ticker: tc.args.ticker, company: "Tata Motors" }),
      tool_call_id: tc.id!,
      name: tc.name
    });
    // @ts-ignore
    messages.push(toolMsg);

    // Manual Injection that I added to agent
    messages.push(new HumanMessage(`The tools returned the following data. Use it to answer the user's question: "Get me the current stock price for TATAMOTORS."\n\nDo NOT ask for clarification. Present the data immediately.\n\n[get_market_data result]: ${toolMsg.content}`));

    console.log("\n--- Turn 2: Sending tool result back to model ---");
    let res2 = await modelWithTools.invoke(messages);
    console.log("Turn 2 AI response:", res2.content);
  }
}

test().catch(console.error);
