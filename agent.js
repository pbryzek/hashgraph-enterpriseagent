/**
 * agent.js — creates the Hedera Agent Kit executor with the NatureBackers plugin
 *
 * Architecture:
 *   ServerSigner → HederaAgentKit (autonomous) → NatureBackersPlugin
 *   → LangChain AgentExecutor (createToolCallingAgent)
 */

import 'dotenv/config';
import { HederaAgentKit, ServerSigner } from 'hedera-agent-kit';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { AgentExecutor, createToolCallingAgent } from 'langchain/agents';
import { NatureBackersPlugin } from './plugins/NatureBackersPlugin.js';

const SYSTEM_PROMPT =
  `You are the CarbonSustain AI agent specialising in nature-based solutions and ` +
  `environmental sustainability. You help sustainability officers, coaches, and campaign ` +
  `organisers discover relevant projects from the NatureBackers registry.\n\n` +
  `Your Hedera operator account is {operator_id}.\n\n` +
  `When a user asks about projects, campaigns, or sustainability initiatives, call ` +
  `search_nature_projects with a well-crafted query derived from their request. ` +
  `Present results clearly — include project names, schemas, and SDG relevance.`;

async function buildLlm() {
  const provider = (process.env.LLM_PROVIDER || 'openai').toLowerCase();

  if (provider === 'gemini') {
    const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
    return new ChatGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_API_KEY,
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
      temperature: 0.1,
    });
  }

  if (provider === 'anthropic') {
    const { ChatAnthropic } = await import('@langchain/anthropic');
    return new ChatAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      temperature: 0.1,
    });
  }

  const { ChatOpenAI } = await import('@langchain/openai');
  return new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    modelName: process.env.OPENAI_MODEL_NAME || 'gpt-4o',
    temperature: 0.1,
  });
}

export async function initAgent() {
  const signer = new ServerSigner(
    process.env.HEDERA_ACCOUNT_ID,
    process.env.HEDERA_PRIVATE_KEY,
    process.env.HEDERA_NETWORK || 'testnet'
  );

  const kit = new HederaAgentKit(
    signer,
    { plugins: [new NatureBackersPlugin()] },
    'autonomous'
  );

  await kit.initialize();

  const tools = kit.getAggregatedLangChainTools();
  const operatorId = signer.getAccountId().toString();
  const systemMessage = SYSTEM_PROMPT.replace('{operator_id}', operatorId);

  const llm = await buildLlm();

  const prompt = ChatPromptTemplate.fromMessages([
    ['system', systemMessage],
    new MessagesPlaceholder('chat_history'),
    ['human', '{input}'],
    new MessagesPlaceholder('agent_scratchpad'),
  ]);

  const agent = createToolCallingAgent({ llm, tools, prompt });

  return new AgentExecutor({
    agent,
    tools,
    verbose: process.env.NODE_ENV !== 'production',
    maxIterations: 5,
  });
}
