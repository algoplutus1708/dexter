import { Agent } from './src/agent/agent.ts';

const prompt = 'Analyze RELIANCE as a stock. Start with current price, valuation, growth, margins, free cash flow, debt, and a one-paragraph thesis. End with 3 risks';

const agent = await Agent.create({
  model: 'qwen2.5:14b',
  maxIterations: 5,
  memoryEnabled: false,
});

for await (const event of agent.run(prompt)) {
  if (event.type === 'tool_start') {
    console.log(`tool_start ${event.tool}`);
  } else if (event.type === 'tool_end') {
    console.log(`tool_end ${event.tool}`);
  } else if (event.type === 'tool_error') {
    console.log(`tool_error ${event.tool}: ${event.error}`);
  } else if (event.type === 'thinking') {
    console.log(`thinking ${event.message.slice(0, 120)}`);
  } else if (event.type === 'done') {
    console.log('DONE');
    console.log(event.answer);
  }
}
