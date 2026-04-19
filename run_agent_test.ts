import { Agent } from './src/agent/agent.js';
import { InMemoryChatHistory } from './src/utils/in-memory-chat-history.js';

async function test() {
  const agent = await Agent.create({ model: 'qwen2.5:14b', maxIterations: 3 });
  const history = new InMemoryChatHistory();
  
  console.log("--- Starting Agent loop ---");
  for await (const event of agent.run("Get me the current stock price for TATAMOTORS.", history)) {
    console.log(event.type);
    if (event.type === 'done') {
      console.log("FINAL ANSWER:\n", event.answer);
    }
  }
}
test().catch(console.error);
