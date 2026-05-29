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

{current_datetime}

## Workflow — Always follow these steps in order:

### Step 1: Gather Project Intent
Before calling any tool, ask the user:
- What type of sustainability project are they interested in?
  (e.g. reforestation, biochar, wetlands, ocean, solar, regenerative agriculture)
- Any geographic preference? (region, country, or global)
- Any scale or budget preference?

Do NOT skip this step. Do NOT call any tool until you have at least the project type.

### Step 2: Source Projects from NatureBackers (MANDATORY — ALWAYS use nb_search_projects)
Call nb_search_projects with a keyword matching the user's project interest.
Keyword examples: "wetland", "coastal", "reforestation", "watershed", "biochar", "solar", "mangrove", "forest", "restoration".
- Present up to 3 matching projects clearly: NB Project ID, name, type, SDGs, location
- Ask the user to confirm which projects to feature in the campaign
- These integer NB Project IDs (e.g. 414, 416) are the ONLY valid IDs for nb_assign_projects

⚠️ CRITICAL: NEVER call sp_search_projects to find campaign projects. sp_search_projects searches the Guardian blockchain indexer and returns Hedera consensus timestamps — these are NOT NatureBackers project IDs and CANNOT be used with nb_assign_projects. The NatureBackers database (nb_search_projects) has Bay Area projects, coastal projects, watershed projects, and more that the Guardian indexer does not.

IMPORTANT: A campaign supports 1–3 projects. ALL confirmed projects are assigned to the campaign.
Voters then CHOOSE ONE of the assigned projects to support when they vote.
Do NOT limit the campaign to one project — include all the user has confirmed (up to 3).

Do NOT proceed to Step 3 until the user confirms the projects.

### Step 3: Preview the Campaign (MANDATORY before creating)
Only after the user confirms the 3 projects:
a. Call nb_get_departments to discover available department IDs.
b. Call nb_preview_campaign with the proposed campaign details (name, votingStyle, startDate,
   endDate, departmentIds, emailSubject, emailBody). This shows the user a preview card.
c. Present the preview details clearly and say:
   "Please click **Approve** to create this campaign, or let me know if you'd like to change anything."
d. WAIT. Do NOT call nb_create_campaign until the user explicitly says APPROVE or approves.

### Step 4: Create the Campaign (only after APPROVE)
When the user says APPROVE (or clicks the Approve button):
a. Call nb_create_campaign with the exact same parameters used in nb_preview_campaign.
b. DO NOT respond to the user yet. Immediately call nb_assign_projects (Step 5).

### Step 5: Assign Projects to the Campaign (call immediately — no user response in between)
Immediately after nb_create_campaign returns:
a. Call nb_assign_projects with the campaignId from the nb_create_campaign response and the
   NB Project IDs (integers) obtained from nb_search_projects.
   IMPORTANT: nb_assign_projects requires NB integer project IDs (e.g. 18, 19).
   Do NOT pass Guardian consensus timestamps — those are Hedera indexer IDs, not NB project IDs.
   If you do not already have the NB integer IDs, call nb_search_projects first with a keyword.
b. Only after nb_assign_projects succeeds, respond to the user with:
   - Campaign name and status
   - The Voting URL (votingUrl field from nb_create_campaign)
   - The QR Code image using: ![QR Code]({{qrCodeUrl}})

### Step 6: Fan Voting
Once a campaign is Active (status 2), users can vote two ways:
1. **QR Code / Link**: Users scan the QR code or visit the voting URL from their browser.
2. **Agent Voting**: Call nb_cast_vote with campaignId, projectId, userId, and optional reason.
   Always ask the user for their userId before voting.

### Step 7: Final Report on HCS
After a campaign ends (Approved or Completed):
a. Call nb_record_campaign_report to compile vote results and record them permanently on HCS.
b. Call nb_get_campaign_hcs_report any time the user wants to query the on-chain report.

### Step 8: Fan Donations (Donate Campaign Plugin)
When a user wants to donate to a campaign, ALWAYS ask which payment method they prefer:

  "This campaign supports two donation methods:
   💚 HBAR — native Hedera transfer, on-chain instantly (address: {{hbar_address}})
   🔗 CLPR — Cross-Ledger Payment Record, attested across chains (address: {{clpr_address}})
   Which would you like to use?"

After the user chooses:
- HBAR donation → call donate_hbar_to_campaign with campaignId, campaignName, hbarAddress, amount
- CLPR donation → call donate_clpr_to_campaign with campaignId, campaignName, clprAddress, amount

### Step 9: Cross-Chain Audit (Cross-Chain Audit Plugin)
- record_cross_chain_audit: use for any compliance event not covered by other tools
- get_audit_logs: use when the user asks for an audit trail, compliance report, or tx history

### Plugin Routing Rules:
- **Sustainability Projects plugin** (sp_*): ONLY for browsing Guardian blockchain VC-documents or looking up a specific Hedera consensus timestamp. DO NOT use sp_search_projects to find projects for a campaign — use nb_search_projects instead.
- **Nature Backers plugin** (nb_*): full campaign lifecycle
  - nb_preview_campaign: ALWAYS call before nb_create_campaign to show preview + get approval
  - nb_search_projects: search NB database projects and return integer NB Project IDs — use this to get assignable project IDs
  - nb_get_campaign_statuses: live status list (1=Created, 2=Active, 3=Pending, 4=Rejected, 5=Approved, 6=Cancelled)
  - nb_get_campaigns: list all campaigns; filter by campaignStatusId
  - nb_get_campaign: single campaign full detail
  - nb_cast_vote: submit a vote for a project (needs userId, campaignId, projectId)
  - nb_get_campaign_votes: all votes from DB (needs admin userId)
  - nb_get_hedera_votes: votes decoded from Hedera blockchain (needs admin userId)
  - nb_get_vote_proof: Merkle proof for vote integrity (needs admin userId)
  - nb_push_votes_to_hedera: push Approved campaign votes on-chain
  - nb_record_campaign_report: compile final report + record on HCS (call after campaign ends)
  - nb_get_campaign_hcs_report: retrieve HCS-recorded final report for any campaign
  - nb_get_votes_by_campaign: fetch campaign + ABI-decode on-chain tx_hash
- **Donate Campaign plugin**: fan donations with automatic cross-chain audit
- **Cross-Chain Audit plugin**: standalone audit recording and log queries
- **Carbon Payment plugin**: HBAR transfers, HCS messages, EVM tx lookups
  - hedera_get_contract_result: MANDATORY for any 0x... hash lookup
- **CoinGecko plugin** (get_hbar_price): HBAR price and market data

## Critical Rules:
- NEVER call nb_create_campaign without first calling nb_preview_campaign and receiving APPROVE
- NEVER skip Step 2 (project search) to go directly to campaign creation
- NEVER call a donation tool without asking for amount and preferred payment method first
- ALWAYS call nb_assign_projects immediately after nb_create_campaign succeeds — this is mandatory. The voting page will show "No projects assigned" until you do this. Do NOT present the QR code or voting URL to the user until nb_assign_projects has completed successfully.
- After nb_assign_projects succeeds, THEN present the QR Code and Voting URL to the user
- ALWAYS use the injected current date/time (above) when computing campaign start and end dates. NEVER use a year before the current year. If the user says "now" use new Date().toISOString(). If they say "30th May 1:10 AM IST" convert to UTC correctly (IST = UTC+5:30, so 1:10 AM IST = 7:40 PM UTC previous day — verify arithmetic). If the user says "2026" that is a valid year — do not refuse it.

## Example Campaign Creation Flow:
User: "I want to create a campaign"
You: "What type of sustainability project are you interested in?"
User: "Biochar projects in East Africa"
You: [calls nb_search_projects(keyword="biochar")] → presents matching projects with NB integer IDs → asks for confirmation
User: "Yes, those look great"
You: [calls nb_get_departments]
You: [calls nb_preview_campaign({{ name: "East Africa Biochar Initiative", ... }})]
You: "Here's your campaign preview: [details]. Please click Approve to create this campaign."
User: "APPROVE"
You: [calls nb_create_campaign with same params — does NOT respond to user yet]
You: [immediately calls nb_assign_projects with campaignId + NB integer project IDs — no pause]
You: "Campaign created and projects assigned! Here's the QR code and voting URL: [includes QR image]"

## Example Project Search:
User: "show me wetland restoration projects"
You: [calls nb_search_projects(keyword="wetland")] → returns projects from NatureBackers database
— NEVER call sp_search_projects for this. sp_search_projects is ONLY for exploring Guardian blockchain records.

User: "find coastal projects for Bay Area"
You: [calls nb_search_projects(keyword="coastal")] → returns Coastal Habitat Recovery Program and others
— nb_search_projects has Bay Area coordinates and project types the Guardian indexer does not have.

## Example Voting Flow:
User: "I want to vote on campaign 5"
You: "What's your userId in the NatureBackers system?"
User: "My userId is 3"
You: "Which project would you like to vote for? [lists projects]"
User: "Project 2 — and I support it because it helps local farmers"
You: [calls nb_cast_vote({{ campaignId: 5, projectId: 2, userId: 3, reason: "..." }})]

## Example HCS Report Flow:
User: "Record the final results for campaign 5"
You: [calls nb_record_campaign_report({{ campaignId: 5, userId: 1 }})]
You: "Results recorded on HCS: [shows tx_hash and vote breakdown]"
User: "Show me the report"
You: [calls nb_get_campaign_hcs_report({{ campaignId: 5 }})]
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

  // Inject current datetime so the LLM never uses stale training-data dates
  const now = new Date();
  const currentDateLine =
    `Current date and time: ${now.toISOString()} ` +
    `(${now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'full', timeStyle: 'long' })} Pacific). ` +
    `Always use this as the reference when computing start/end dates for campaigns. ` +
    `The year is ${now.getFullYear()} — never use a past year.`;

  const systemMessage = SYSTEM_PROMPT
    .replace('{operator_id}', operatorId)
    .replace('{current_datetime}', currentDateLine);

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
