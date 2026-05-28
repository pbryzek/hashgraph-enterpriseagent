/**
 * agent.js — creates the Hedera Agent Kit executor with plugins:
 *   HederaSustainabilityProjectPlugin  (sp_* — source/browse projects)
 *   NatureBackersCampaignPlugin        (nb_* — create/manage campaigns)
 *   CarbonPaymentPlugin                (transfer_hbar, submit_hcs_message — write tools)
 *   CoinGeckoPlugin                    (get_hbar_price)
 *
 * Enterprise middleware wraps every tool with hooks (pre/post logging) and
 * policies (HBAR transfer limits, memo enforcement) before the agent sees them.
 */

import 'dotenv/config';
import { HederaAgentKit, ServerSigner } from 'hedera-agent-kit';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { AgentExecutor, createToolCallingAgent } from 'langchain/agents';
import { HederaSustainabilityProjectPlugin } from './plugins/HederaSustainabilityProjectPlugin.js';
import { NatureBackersCampaignPlugin } from './plugins/NatureBackersCampaignPlugin.js';
import { CoinGeckoPlugin } from './plugins/CoinGeckoPlugin.js';
import { CarbonPaymentPlugin } from './plugins/CarbonPaymentPlugin.js';
import { CrossChainAuditPlugin } from './plugins/CrossChainAuditPlugin.js';
import { DonateCampaignPlugin } from './plugins/DonateCampaignPlugin.js';

// ── Sports Market Research system prompt ──────────────────────────────────────

const SPORTS_RESEARCH_PROMPT = `
You are an expert sports market researcher and campaign strategist for Nature Backers,
a fan engagement platform that connects sports communities with environmental impact campaigns.

Your job is to identify the best women's sports teams, leagues, athletes, and events
in a given geographic area that are strong candidates for a Nature Backers campaign.

## YOUR THINKING FRAMEWORK

**Step 1 — Cast a wide net**
Scan ALL categories of women's sports in the area:
- Professional teams (NWSL, WNBA, NWHL, LPGA tour stops, WTA tennis, etc.)
- Semi-pro and USL leagues
- College programs (D1, D2, D3 — especially flagship state schools)
- Amateur and recreational leagues with large community followings
- Individual athletes with local fame (runners, climbers, cyclists, triathletes)
- Recurring events (marathons, tournaments, invitationals, championships)
- Youth leagues and organizations with strong parent/community bases

**Step 2 — Score each candidate on Nature Backers fit**
Rate each on:
- 🌿 Environmental alignment — does the team/org already care about sustainability or nature?
- 👥 Fan base size and engagement — active, passionate, digital-savvy fans?
- 📣 Community visibility — media coverage, social following, local pride factor?
- 💰 Sponsorship gap — are they underfunded and likely to welcome creative partnerships?
- 🤝 Campaign receptivity — would this org be open to a fan-funded environmental initiative?
- 📅 Timing — are there upcoming games, seasons, or events that create a natural campaign window?

**Step 3 — Recommend the top candidates**
For each recommendation, provide:
- Team/event name and sport
- Why they're a strong Nature Backers fit (2–3 sentences)
- Their fan base profile
- A suggested campaign angle (e.g., "Plant a tree for every home win")
- Ideal campaign launch timing
- Any known environmental initiatives they already have

**Step 4 — Flag hidden gems**
Look beyond the obvious. Prioritize:
- Sports with passionate but underserved fan bases (roller derby, rugby, lacrosse,
  softball, field hockey, volleyball, water polo)
- Orgs without existing corporate sponsors who would value a Nature Backers partnership
- Athletes or events with viral/social potential even if small today

## TONE AND OUTPUT
- Be specific — name actual teams, leagues, and events, not just categories
- Be opinionated — rank your recommendations and explain why
- Think like a campaign strategist, not just a list-maker
- Always tie your reasoning back to what makes a Nature Backers campaign succeed:
  fan energy + environmental resonance + community pride

When given a city or region, return a ranked shortlist of 5–10 candidates
with a brief memo on each and a suggested top pick to launch with first.

After presenting your recommendations, always end with:
"Ready to create a Nature Backers campaign? Tell me which team or event you'd like to feature and I'll hand off to the campaign creation agent."
`.trim();

// ── Campaign creation system prompt ──────────────────────────────────────────

const SYSTEM_PROMPT = `
You are CarbonSustain's enterprise agent — a Nature Backers campaign assistant with
blockchain payment and audit capabilities on Hedera.

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

### Step 5: Fan Donations (Donate Campaign Plugin)
When a user wants to donate to a campaign, ALWAYS ask which payment method they prefer:

  "This campaign supports two donation methods:
   💚 HBAR — native Hedera transfer, on-chain instantly (address: {{hbar_address}})
   🔗 CLPR — Cross-Ledger Payment Record, attested across chains (address: {{clpr_address}})
   Which would you like to use?"

After the user chooses:
- HBAR donation → call donate_hbar_to_campaign with campaignId, campaignName, hbarAddress, amount
- CLPR donation → call donate_clpr_to_campaign with campaignId, campaignName, clprAddress, amount

Both tools automatically record a cross-chain audit (HCS + CLPR) after execution.
Never call either donation tool until the user has explicitly confirmed the amount and method.

### Step 6: Cross-Chain Audit (Cross-Chain Audit Plugin)
- record_cross_chain_audit: use for any compliance event not covered by a donation tool
  (e.g., campaign approval, vote recorded, project verification)
- get_audit_logs: use when the user asks for an audit trail, compliance report, or tx history
  Supports filtering by eventType, entityId, actor, status, or tag.

### Plugin Routing Rules:
- **Sustainability Projects plugin** (sp_*): ONLY for sourcing, searching, or retrieving projects
- **Nature Backers plugin** (nb_*): full campaign lifecycle — create, list, vote, audit
  - nb_get_campaign_statuses: live status list (1=Created, 2=Active, 3=Pending, 4=Rejected, 5=Approved, 6=Cancelled)
  - nb_get_campaigns: list all campaigns with status name, departments, vote count; filter by campaignStatusId
  - nb_get_campaign: single campaign full detail (projects + departments + email body + tx_hash)
  - nb_get_campaign_votes: all votes from DB with voter name/email, project, reason, vote_hash (needs admin userId)
  - nb_get_hedera_votes: votes decoded from Hedera blockchain for Approved campaigns (needs admin userId)
  - nb_get_vote_proof: Merkle proof for vote integrity verification (needs admin userId)
  - nb_push_votes_to_hedera: push Approved campaign votes on-chain, generates Merkle root
  - nb_get_votes_by_campaign: fetch campaign + ABI-decode on-chain tx_hash from Hedera mirror node
- **Donate Campaign plugin**: fan donations with automatic cross-chain audit
  - donate_hbar_to_campaign: HBAR transfer + HCS + CLPR audit
  - donate_clpr_to_campaign: CLPR payment record + HCS + CLPR audit
- **Cross-Chain Audit plugin**: standalone audit recording and log queries
  - record_cross_chain_audit: write event to HCS + CLPR concurrently (integrity hash attested on both)
  - get_audit_logs: filter audit history by eventType, entityId, actor, status, or tag
- **Carbon Payment plugin**: direct HBAR transfers, raw HCS messages, EVM tx lookups
  - hedera_get_contract_result: MANDATORY — call this immediately whenever the user provides
    a 0x... hash and asks to query/fetch/look up/check it on Hedera or Hashgraph.
    NEVER answer from memory. ALWAYS call the tool first, then present the result.
- **CoinGecko plugin** (get_hbar_price): call whenever the user asks about HBAR price or market data
- Never skip Step 2 to go directly to campaign creation
- Never call nb_create_campaign without confirmed project IDs from sp_search_projects
- Never call a donation tool without asking the user for amount and preferred payment method first

## Example Donation Flow:
User: "I want to donate to this campaign"
You: "This campaign supports two donation methods: 💚 HBAR ... 🔗 CLPR ... Which would you like?"
User: "HBAR, 5 HBAR"
You: "Confirmed — donating 5 HBAR to campaign [name] at address [hbarAddress]. Proceeding..."
You: [calls donate_hbar_to_campaign({{ campaignId, campaignName, hbarAddress, amount: 5 }})]

## Example Campaign Creation Flow:
User: "I want to create a campaign"
You: "What type of sustainability project are you interested in?" ← always start here
User: "Biochar projects in East Africa"
You: [calls sp_search_projects({{ sdgs: ["climate Action"], type: "biochar" }})]
You: "Here are the top 3 projects: ..." → asks for confirmation
User: "Yes, create the campaign"
You: [calls nb_create_campaign({{ name: "...", votingStyle: "STORY_FEATURE", startDate: "...", endDate: "...", departmentIds: [1] }})]
You: [calls nb_assign_projects({{ campaignId: <id>, projectIds: [...] }})]
You: [calls record_cross_chain_audit({{ eventType: "CAMPAIGN_CREATED", entityId: "campaign-<id>", ... }})]
`.trim();

// ── Enterprise hooks + policies middleware ─────────────────────────────────────
//
// Wraps every LangChain tool with:
//   Hooks   — pre/post execution logging (structured audit trail)
//   Policies — parameter validation rules enforced before any tool runs

const ENTERPRISE_HOOKS = {
  async onPreToolExecution(toolName, params) {
    console.log(
      `[ENTERPRISE AUDIT] ▶ ${toolName} | ${new Date().toISOString()} | params: ${JSON.stringify(params)}`
    );
  },
  async onPostToolExecution(toolName, result) {
    const preview = String(result).slice(0, 150);
    console.log(`[ENTERPRISE AUDIT] ✓ ${toolName} | result: ${preview}${result?.length > 150 ? '…' : ''}`);
  },
};

const ENTERPRISE_POLICIES = [
  {
    name: 'HBAR transfer spend limit',
    validate(toolName, params) {
      if (toolName === 'transfer_hbar') {
        const amount = Number(params?.amount ?? 0);
        if (amount > 50) {
          throw new Error(
            `Enterprise policy violation [${this.name}]: ` +
            `requested ${amount} HBAR exceeds the 50 HBAR per-transfer limit. ` +
            `Break into smaller transfers or escalate for manual approval.`
          );
        }
      }
    },
  },
  {
    name: 'Transfer memo required',
    validate(toolName, params) {
      if (toolName === 'transfer_hbar' && !params?.memo?.trim()) {
        throw new Error(
          `Enterprise policy violation [${this.name}]: ` +
          `HBAR transfers must include a memo (project ID or campaign name) for audit trail compliance.`
        );
      }
    },
  },
];

function applyEnterpriseMiddleware(tools) {
  return tools.map(tool => {
    const originalInvoke = tool.invoke.bind(tool);
    tool.invoke = async (input, runManager) => {
      let params;
      try {
        params = typeof input === 'string' ? JSON.parse(input) : input;
      } catch {
        params = input;
      }

      for (const policy of ENTERPRISE_POLICIES) {
        policy.validate(tool.name, params);
      }

      await ENTERPRISE_HOOKS.onPreToolExecution(tool.name, params);
      const result = await originalInvoke(input, runManager);
      await ENTERPRISE_HOOKS.onPostToolExecution(tool.name, result);

      return result;
    };
    return tool;
  });
}

// ── LLM factory ────────────────────────────────────────────────────────────────

// Switch providers by setting LLM_PROVIDER in .env:
//   LLM_PROVIDER=gemini    → Google Gemini (GOOGLE_API_KEY, GEMINI_MODEL)
//   LLM_PROVIDER=openai    → OpenAI       (OPENAI_API_KEY, OPENAI_MODEL_NAME)
//   LLM_PROVIDER=anthropic → Anthropic    (ANTHROPIC_API_KEY, ANTHROPIC_MODEL)
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

  // Default: OpenAI
  const { ChatOpenAI } = await import('@langchain/openai');
  return new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    modelName: process.env.OPENAI_MODEL_NAME || 'gpt-4o',
    temperature: 0.1,
  });
}

// ── Research agent (pure LLM, no Hedera tools) ───────────────────────────────

export async function initResearchAgent() {
  const llm = await buildLlm();
  const prompt = ChatPromptTemplate.fromMessages([
    ['system', SPORTS_RESEARCH_PROMPT],
    new MessagesPlaceholder('chat_history'),
    ['human', '{input}'],
  ]);

  const chain = prompt.pipe(llm);

  return {
    invoke: async ({ input, chat_history = [] }, options) => {
      const result = await chain.invoke({ input, chat_history }, options);
      const content = typeof result.content === 'string'
        ? result.content
        : Array.isArray(result.content)
          ? result.content.map(b => (typeof b === 'string' ? b : b.text ?? '')).join('')
          : String(result.content ?? '');
      return { output: content };
    },
  };
}

// ── Campaign agent (full Hedera plugins) ─────────────────────────────────────

export async function initCampaignAgent() {
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
        new CoinGeckoPlugin(),
        new CarbonPaymentPlugin(),
        new CrossChainAuditPlugin(),
        new DonateCampaignPlugin(),
      ],
    },
    'autonomous'
  );

  await kit.initialize();

  const rawTools = kit.getAggregatedLangChainTools();
  const tools = applyEnterpriseMiddleware(rawTools);
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
