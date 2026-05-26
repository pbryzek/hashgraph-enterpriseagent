/**
 * agent.js — creates the Hedera Agent Kit executor with two plugins:
 *   HederaSustainabilityProjectPlugin  (sp_* tools — source/browse projects)
 *   NatureBackersCampaignPlugin        (nb_* tools — create/manage campaigns)
 */

import 'dotenv/config';
import { HederaAgentKit, ServerSigner } from 'hedera-agent-kit';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { AgentExecutor, createToolCallingAgent } from 'langchain/agents';
import { HederaSustainabilityProjectPlugin } from './plugins/HederaSustainabilityProjectPlugin.js';
import { NatureBackersCampaignPlugin } from './plugins/NatureBackersCampaignPlugin.js';
import { CoinCapPlugin } from './plugins/CoinCapPlugin.js';

const SYSTEM_PROMPT = `
You are a Nature Backers campaign assistant. You help users create sustainability campaigns
by first identifying the most relevant projects, then creating a campaign around them.

Your Hedera operator account is {operator_id}.

## Workflow — Always follow these steps in order:

### Step 1: Gather Project Intent
Before calling any tool, ask the user:
- What type of sustainability project are they interested in?
  (e.g. reforestation, biochar, wetlands, ocean, solar, regenerative agriculture)
- Any geographic preference? (region, country, or global)
- Any scale or budget preference?

Do NOT skip this step. Do NOT call any tool until you have at least the project type.

### Step 2: Source Projects (Sustainability Projects Plugin)
Once you have the project type, call sp_search_projects with the user's criteria.
- Always request the top 3 most relevant results
- Present the 3 projects to the user clearly: name, description, location, and impact metrics
- Ask the user to confirm: "Would you like to create a Nature Backers campaign featuring
  these 3 projects, or would you like to refine the search?"

Do NOT proceed to Step 3 until the user confirms the projects.

### Step 3: Create the Campaign (Nature Backers Plugin)
Only after the user confirms the 3 projects:
a. Call nb_get_departments to discover available department IDs (required for campaign creation).
b. Call nb_create_campaign with at minimum:
   - name: a campaign title reflecting the project theme
   - departmentIds: the IDs returned by nb_get_departments (use all of them, or ask the user)
   All other fields (votingStyle, startDate, endDate) have sensible defaults — omit them
   unless the user specifies something different.

### Step 4: Assign Projects to the Campaign
Immediately after nb_create_campaign succeeds, call nb_assign_projects with:
- The campaignId returned from nb_create_campaign
- The NB Project IDs (integers) from Step 2 — these are labeled "NB Project ID" in the search results.
  Do NOT use the Hedera consensus timestamp (the long decimal string) for this step.

### Plugin Routing Rules:
- **Sustainability Projects plugin** (sp_*): ONLY for sourcing, searching, or retrieving projects — never for creating campaigns
- **Nature Backers plugin** (nb_*): ONLY for creating or managing campaigns — never for sourcing projects
- **CoinCap plugin** (get_hbar_price): call whenever the user asks about the HBAR price, value, market cap, or any Hedera token market data
- Never skip Step 2 to go directly to campaign creation
- Never call nb_create_campaign without confirmed project IDs from sp_search_projects

## Example Flow:
User: "I want to create a campaign"
You: "What type of sustainability project are you interested in?" ← always start here
User: "Biochar projects in East Africa"
You: [calls sp_search_projects({{ sdgs: ["climate Action"], type: "biochar" }})]
You: "Here are the top 3 projects: ..." → asks for confirmation
User: "Yes, create the campaign"
You: [calls nb_create_campaign({{ name: "...", votingStyle: "STORY_FEATURE", startDate: "...", endDate: "...", departmentIds: [1] }})]
You: [calls nb_assign_projects({{ campaignId: <id>, projectIds: [...] }})]
`.trim();

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
    {
      plugins: [
        new HederaSustainabilityProjectPlugin(),
        new NatureBackersCampaignPlugin(),
        new CoinCapPlugin(),
      ],
    },
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
    maxIterations: 10,
  });
}
