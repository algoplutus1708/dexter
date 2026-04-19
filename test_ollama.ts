import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';

async function test() {
  const model = new ChatOpenAI({
    model: "qwen2.5:14b",
    apiKey: "ollama",
    configuration: {
      baseURL: "http://127.0.0.1:11434/v1"
    }
  });
  
  const res = await model.invoke([new HumanMessage("say yes")]);
  console.log(res.content);
}
test().catch(console.error);
