import { Agent } from '../src/agent/agent.js';
import { resolveProvider } from '../src/providers.js';

async function main() {
  const model = 'qwen2.5:14b';
  console.log(`Running with model: ${model}`);
  
  const agent = await Agent.create({
    model,
    maxIterations: 5,
  });

  const query = "Fetch the latest shareholding pattern for RELIANCE.NSE. Has there been any change in the promoter holding or foreign institutional investor (FII) holding over the last two quarters?";
  
  console.log(`Prompt: ${query}`);
  
  for await (const event of agent.run(query)) {
    if (event.type === 'tool_start') {
      console.log(`Running tool: ${event.tool}`);
    } else if (event.type === 'tool_end') {
      console.log(`Tool ${event.tool} finished. Length: ${event.result.length}`);
    } else if (event.type === 'thinking') {
      console.log(`Thinking: ${event.message}`);
    } else if (event.type === 'done') {
      console.log(`Answer:\n${event.answer}`);
      break;
    }
  }
}

main().catch(console.error);
