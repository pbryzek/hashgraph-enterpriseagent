/**
 * server.js — Express backend for CarbonSustain Hedera agent
 *
 * POST /api/agent        — SSE stream of agent steps + final result with tx IDs
 * GET  /api/campaigns/:id — proxy to NatureBackers campaign detail (for VotePage)
 * POST /api/vote         — proxy vote submission (email → userId lookup + forward)
 * GET  /health           — liveness check for Cloud Run
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { initResearchAgent, initCampaignAgent } from './agent.js';

const __serverDir = dirname(fileURLToPath(import.meta.url));

const NB_BASE_URL = 'https://d3chyxfaxhbtc9.cloudfront.net';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors());

// Global request logger
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url} | Body size: ${JSON.stringify(req.body).length} bytes`);
  next();
});

let researchExecutor;
let campaignExecutor;

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Public config (non-sensitive) — used by frontend for wallet integration ───

app.get('/api/config', (_req, res) => {
  res.json({
    adminAccountId: process.env.HEDERA_ACCOUNT_ID ?? null,
    network: (process.env.HEDERA_NETWORK || 'testnet').toLowerCase(),
  });
});

// ── Campaign detail proxy (used by VotePage) ──────────────────────────────────

app.get('/api/campaigns/:id', async (req, res) => {
  try {
    const resp = await axios.get(`${NB_BASE_URL}/campaign/${req.params.id}`, {
      timeout: 15_000,
      headers: process.env.NATURE_BACKERS_TOKEN
        ? { Authorization: `Bearer ${process.env.NATURE_BACKERS_TOKEN}` }
        : {},
    });
    res.json(resp.data);
  } catch (err) {
    const status = err?.response?.status ?? 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Project detail proxy (used by VotePage) ───────────────────────────────────

app.get('/api/projects/:id', async (req, res) => {
  try {
    const resp = await axios.get(`${NB_BASE_URL}/project/${req.params.id}`, {
      timeout: 15_000,
      headers: process.env.NATURE_BACKERS_TOKEN
        ? { Authorization: `Bearer ${process.env.NATURE_BACKERS_TOKEN}` }
        : {},
    });
    res.json(resp.data);
  } catch (err) {
    const status = err?.response?.status ?? 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Vote proxy (QR code voting page) ─────────────────────────────────────────
// Accepts { email, campaignId, projectId, reason? }
// Resolves email → userId via GET /user/email/:email (NatureBackers API), then forwards vote

app.post('/api/vote', async (req, res) => {
  const { email, campaignId, projectId, reason } = req.body;

  if (!email || !campaignId || !projectId) {
    return res.status(400).json({ error: 'email, campaignId, and projectId are required.' });
  }

  try {
    // Resolve email → userId using the NatureBackers user endpoint
    const userResp = await axios.get(`${NB_BASE_URL}/user/email/${encodeURIComponent(email)}`, {
      timeout: 15_000,
      headers: process.env.NATURE_BACKERS_TOKEN
        ? { Authorization: `Bearer ${process.env.NATURE_BACKERS_TOKEN}` }
        : {},
    });

    const userId = userResp.data?.data?.id ?? userResp.data?.id;

    if (!userId) {
      return res.status(404).json({
        error: `Email "${email}" is not registered in the Nature Backers system. Please use your work email.`,
      });
    }

    // Submit the vote
    const votePayload = { userId, campaignId: Number(campaignId), projectId: Number(projectId) };
    if (reason) votePayload.reason = reason.slice(0, 500);

    const voteResp = await axios.post(`${NB_BASE_URL}/vote`, votePayload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15_000,
    });

    res.json(voteResp.data);
  } catch (err) {
    const status = err?.response?.status ?? 500;
    const message = err?.response?.data?.message ?? err.message;
    res.status(status).json({ error: message });
  }
});

// ── Agent endpoint (SSE) ──────────────────────────────────────────────────────

// Campaign tool intent — any message that requires a plugin tool must reach the
// campaignExecutor regardless of which UI phase is active. The researchExecutor
// is a plain LLM chain with no tools, so tool-requiring queries sent there will
// produce "tool not available" errors.
const CAMPAIGN_TOOL_INTENT = new RegExp(
  [
    // Donations / payments
    '\\bdonat(?:e|ion|ing)\\b',
    '\\b\\d+(?:\\.\\d+)?\\s*hbar\\b',
    '\\bclpr\\b',
    '\\busdc\\b',
    // HCS / audit / reports
    '\\bhcs\\b',
    '\\baudit\\b',
    '\\breport\\b',
    // Campaign / project tool operations
    '\\bcampaign\\s+\\d+\\b',    // "campaign 162"
    '\\bcampaign\\s+id\\b',
    '\\bnb_',                    // explicit tool names
    '\\bvot(?:e|es|ing)\\b',
    '\\bproject\\s+\\d+\\b',
    '\\bassign\\b',
    '\\bapprove\\b',
    '\\brecords?\\b',
    '\\bmerkle\\b',
    '\\bhashscan\\b',
  ].join('|'),
  'i'
);

app.post('/api/agent', async (req, res) => {
  const { message, chatHistory = [], phase = 'research' } = req.body;
  console.log(`[AGENT API] Incoming request: message="${message}", phase="${phase}", historyItems=${chatHistory.length}`);

  if (!message) {
    console.log('[AGENT API] Error: message is required');
    return res.status(400).json({ error: 'message is required' });
  }

  const wantsCampaignTool = CAMPAIGN_TOOL_INTENT.test(message);
  const useCampaign = phase === 'campaign' || wantsCampaignTool;
  const executor = useCampaign ? campaignExecutor : researchExecutor;
  console.log(`[AGENT API] Intent: wantsCampaignTool=${wantsCampaignTool}, useCampaign=${useCampaign} -> using ${useCampaign ? 'campaignExecutor' : 'researchExecutor'}`);

  if (useCampaign && !campaignExecutor) {
    console.error('[AGENT API] CRITICAL: campaignExecutor is undefined!');
  }
  if (!useCampaign && !researchExecutor) {
    console.error('[AGENT API] CRITICAL: researchExecutor is undefined!');
  }

  if (!executor) {
    console.error('[AGENT API] Error: Selected executor is not initialized!');
    return res.status(500).json({ error: 'Agent not ready. Please try again in a moment.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const txIds = [];
  const toolOutputs = [];
  let currentToolName  = null;
  let pendingApproval  = null;
  let pendingPayment   = null; // set when donate_hbar_to_campaign runs

  try {
    send({ type: 'status', step: 'Agent started…' });

    const langchainHistory = chatHistory.flatMap((m) => {
      console.log(`[AGENT API] Parsing history item: type=${m.type || 'unknown'}, role=${m.role || 'unknown'}`);
      
      // Handle standard {role, content} objects
      if (m.role === 'user') return [new HumanMessage(m.content)];
      if (m.role === 'assistant') {
        const msg = new AIMessage(m.content);
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        return [msg];
      }

      // Handle raw LangChain serialized objects (like the ones in your trace)
      if (m.lc === 1 && m.type === 'constructor' && Array.isArray(m.id)) {
        const idStr = m.id.join('/');
        const content = m.kwargs?.content;
        console.log(`[AGENT API] Detected serialized LangChain object: ${idStr}`);

        if (idStr.includes('HumanMessage')) return [new HumanMessage(content)];
        if (idStr.includes('AIMessage')) {
          const msg = new AIMessage(content);
          if (m.kwargs?.tool_calls) msg.tool_calls = m.kwargs.tool_calls;
          return [msg];
        }
        if (idStr.includes('ToolMessage')) {
          return [new ToolMessage({
            content: content,
            tool_call_id: m.kwargs?.tool_call_id,
            additional_kwargs: m.kwargs?.additional_kwargs
          })];
        }
      }

      // Handle other common formats
      if (m._getType?.() === 'human' || m.type === 'human') return [new HumanMessage(m.content)];
      if (m._getType?.() === 'ai' || m.type === 'ai') return [new AIMessage(m.content)];
      if (m.type === 'tool') return [new ToolMessage({ content: m.content, tool_call_id: m.tool_call_id })];

      return [];
    });

    console.log(`[AGENT API] Processed history: ${langchainHistory.length} messages`);
    langchainHistory.forEach((m, i) => {
      const type = m._getType();
      const contentSnippet = typeof m.content === 'string' ? m.content.slice(0, 50) : 'complex content';
      console.log(`  [${i}] ${type}: "${contentSnippet}..." ${m.tool_calls ? `(${m.tool_calls.length} tool calls)` : ''}`);
    });

    const result = await executor.invoke(
      { input: message, chat_history: langchainHistory },
      {
        callbacks: [
          {
            handleChainStart(chain, inputs, runId, parentRunId, tags, metadata, runName) {
              console.log(`[AGENT API] Chain Start: ${runName || 'executor'}`);
            },
            handleToolStart(tool, _input, _runId, _parentRunId, _tags, _metadata, runName) {
              const name = tool?.name ?? runName ?? 'tool';
              currentToolName = name;
              console.log(`[AGENT API] Tool Start: ${name}`);
              send({ type: 'tool_start', step: `Calling ${name}…` });
            },
            handleToolEnd(rawOutput) {
              console.log(`[AGENT API] Tool End: ${currentToolName} | rawOutput length: ${rawOutput?.length}`);
              console.log(`[DEBUG] handleToolEnd called for ${currentToolName}. rawOutput:`, rawOutput?.slice(0, 200));
              try {
                const parsed = JSON.parse(rawOutput);
                const text = parsed?.data ?? parsed?.output ?? rawOutput;
                const textStr = typeof text === 'string' ? text : JSON.stringify(text);
                toolOutputs.push(textStr);
                if (parsed.transactionId) txIds.push(parsed.transactionId);
                if (parsed.receipt?.transactionId)
                  txIds.push(String(parsed.receipt.transactionId));

                // Detect campaign preview for approval flow
                if (currentToolName === 'nb_preview_campaign') {
                  try {
                    const preview = JSON.parse(textStr);
                    if (preview?.__type === 'campaign_preview') {
                      pendingApproval = preview;
                      console.log('[AGENT API] Detected campaign preview');
                      send({ type: 'approval_request', campaignPreview: preview });
                    }
                  } catch { /* not JSON, ignore */ }
                }

                // Detect HashPack payment request. The tool result is wrapped by
                // LangChain as {success, data:"<json>"}, so the payload lives in
                // textStr (the unwrapped data), not rawOutput. Parse textStr the
                // same way the campaign-preview detector above does.
                console.log(`[DEBUG] Tool ${currentToolName} ended. textStr:`, textStr?.slice(0, 100));
                if (textStr && textStr.includes('hashpack_payment_request')) {
                  console.log('[DEBUG] Detected hashpack_payment_request keyword in textStr:', textStr);
                  try {
                    const payment = JSON.parse(textStr);
                    console.log('[DEBUG] Parsed payment object:', JSON.stringify(payment, null, 2));
                    if (payment?.__type === 'hashpack_payment_request') {
                      console.log('[DEBUG] Confirmed hashpack_payment_request type. Setting pendingPayment and sending to client.');
                      pendingPayment = payment;
                      send({ type: 'hashpack_payment', payment });
                    } else if (payment?.__type === 'hashpack_usdc_payment_request') {
                      console.log('[DEBUG] Confirmed hashpack_usdc_payment_request type. Sending USDC payment to client.');
                      send({ type: 'hashpack_usdc_payment', payment });
                    } else {
                      console.log('[DEBUG] textStr included keyword but __type was not hashpack_payment_request. Found type:', payment?.__type);
                    }
                  } catch (e) {
                    console.error('[DEBUG] Failed to parse textStr as JSON even though it contained keyword:', e.message);
                  }
                }
              } catch {
                toolOutputs.push(rawOutput);
              }
              send({ type: 'tool_end', step: 'Tool completed' });
            },
            handleLLMStart() {
              console.log('[AGENT API] LLM Start');
              send({ type: 'llm_start', step: 'Agent thinking…' });
            },
            handleAgentAction(action, runId) {
              console.log(`[AGENT API] Agent Action: ${action.tool} | input: ${JSON.stringify(action.toolInput)}`);
            },
            handleAgentEnd(action, runId) {
              console.log('[AGENT API] Agent Finished Iteration');
            },
            handleChainEnd(output) {
              console.log(`[AGENT API] Chain End. Output keys: ${Object.keys(output || {})}`);
            },
            handleChainError(err) {
              console.error(`[AGENT API] Chain Error: ${err.message}`);
            }
          },
        ],
      }
    );

    console.log('[AGENT API] Invoke completed');

    // ── Fallback Detection ───────────────────────────────────────────────────
    // If real-time callbacks missed a tool result, scan intermediateSteps.
    if (result.intermediateSteps?.length) {
      console.log(`[AGENT API] Scanning ${result.intermediateSteps.length} intermediate steps for missed tools…`);
      for (const { action, observation } of result.intermediateSteps) {
        console.log(`  Step: tool=${action.tool} | observation length=${observation?.length}`);

        try {
          const parsed = typeof observation === 'string' ? JSON.parse(observation) : observation;
          const text = parsed?.data ?? parsed?.output ?? (typeof observation === 'string' ? observation : JSON.stringify(observation));
          const textStr = typeof text === 'string' ? text : JSON.stringify(text);

          // Missed HashPack payment request
          if (!pendingPayment && textStr && textStr.includes('hashpack_payment_request')) {
            console.log(`[AGENT API] Fallback found payment request in step: ${action.tool}`);
            const payment = JSON.parse(textStr);
            if (payment?.__type === 'hashpack_payment_request') {
              pendingPayment = payment;
              send({ type: 'hashpack_payment', payment });
            }
          }

          // Missed campaign preview (e.g. update-times flow where handleToolEnd fires
          // after currentToolName has already moved on, or tool ran but callback raced)
          if (!pendingApproval && action.tool === 'nb_preview_campaign') {
            try {
              const preview = JSON.parse(textStr);
              if (preview?.__type === 'campaign_preview') {
                console.log(`[AGENT API] Fallback found campaign preview in step: ${action.tool}`);
                pendingApproval = preview;
                send({ type: 'approval_request', campaignPreview: preview });
              }
            } catch { /* not a preview JSON */ }
          }
        } catch (e) {
          console.error(`[AGENT API] Fallback parse error: ${e.message}`);
        }
      }
    }

    let output = result.output;
    if (Array.isArray(output)) {
      output = output
        .filter((b) => b?.type === 'text' || typeof b === 'string')
        .map((b) => (typeof b === 'string' ? b : b.text ?? ''))
        .join('\n')
        .trim();
    } else if (typeof output !== 'string') {
      output = String(output ?? '');
    }

    if (!output && toolOutputs.length > 0) {
      output = toolOutputs.join('\n\n---\n\n');
    }

    // Last-resort: if the LLM echoed the preview JSON directly as its text output
    // (happens when it skips re-calling nb_preview_campaign and just outputs the JSON),
    // detect it and treat it as a preview instead of showing raw JSON in the chat.
    if (!pendingApproval && output) {
      try {
        const directParsed = JSON.parse(output.trim());
        if (directParsed?.__type === 'campaign_preview') {
          console.log('[AGENT API] Detected raw campaign_preview JSON in output text — treating as preview');
          pendingApproval = directParsed;
          send({ type: 'approval_request', campaignPreview: directParsed });
        }
      } catch { /* output is not pure JSON */ }
    }

    // If a HashPack payment is pending, always replace the output entirely
    if (pendingPayment) {
      output = `Please sign the **${pendingPayment.amount} HBAR** donation to **${pendingPayment.campaignName}** using your connected HashPack wallet.`;
    }

    // If a campaign preview is pending, always replace the output entirely
    if (pendingApproval) {
      output = `Here is the campaign preview for **${pendingApproval.name}**. Please review the details and click **Approve** to create it, or let me know if you'd like to change anything.`;
    }

    send({
      type: 'done',
      output,
      txIds: [...new Set(txIds)],
      phase,
      needsApproval: pendingApproval !== null,
      campaignPreview: pendingApproval,
      needsPayment: pendingPayment !== null,
      payment: pendingPayment,
    });
  } catch (err) {
    console.error('Agent error:', err);
    send({ type: 'error', error: err.message });
  } finally {
    res.end();
  }
});

// ── Generated report downloads (PDF) ─────────────────────────────────────────
app.use('/api/reports', express.static(join(__serverDir, 'tmp')));

// ── Guardian indexer proxy — adds Bearer token, returns raw VC JSON ───────────
// Used by the in-app /indexer/:timestamp viewer so users don't need Guardian login.
app.get('/api/indexer/vc/*', async (req, res) => {
  const timestamp = req.params[0];
  try {
    const resp = await axios.get(
      `${process.env.NATURE_BACKERS_API_URL}/entities/vc-documents/${encodeURIComponent(timestamp)}`,
      {
        timeout: 15_000,
        headers: process.env.NATURE_BACKERS_TOKEN
          ? { Authorization: `Bearer ${process.env.NATURE_BACKERS_TOKEN}` }
          : {},
      }
    );
    res.json(resp.data);
  } catch (err) {
    res.status(err?.response?.status ?? 500).json({ error: err.message });
  }
});

// ── User: find or create ──────────────────────────────────────────────────────
// POST { firstName, lastName, email }
// Looks up by email; if not found, creates with Fans dept + roleId 3.
app.post('/api/user/ensure', async (req, res) => {
  const { firstName, lastName, email } = req.body;

  if (!firstName?.trim() || !lastName?.trim() || !email?.trim()) {
    return res.status(400).json({ error: 'firstName, lastName, and email are required.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const authHeaders = process.env.NATURE_BACKERS_TOKEN
    ? { Authorization: `Bearer ${process.env.NATURE_BACKERS_TOKEN}` }
    : {};
  const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json' };

  try {
    // 1. Check if user already exists
    let existingUser = null;
    try {
      console.log(`[user/ensure] GET /user/email/${cleanEmail}`);
      const resp = await axios.get(
        `${NB_BASE_URL}/user/email/${encodeURIComponent(cleanEmail)}`,
        { timeout: 10_000, headers: authHeaders }
      );
      existingUser = resp.data?.data ?? resp.data;
      console.log(`[user/ensure] Found user id=${existingUser?.id}`);
    } catch (err) {
      if (err?.response?.status !== 404) throw err;
      console.log(`[user/ensure] User not found — will create`);
    }

    if (existingUser?.id) {
      return res.json({
        created: false,
        user: {
          id:        existingUser.id,
          firstName: existingUser.first_name,
          lastName:  existingUser.last_name,
          email:     existingUser.business_email,
        },
      });
    }

    // 2. Resolve Fans department ID
    console.log(`[user/ensure] GET /department`);
    const deptResp = await axios.get(`${NB_BASE_URL}/department`, {
      timeout: 10_000, headers: authHeaders,
    });
    const departments = Array.isArray(deptResp.data?.data) ? deptResp.data.data
                      : Array.isArray(deptResp.data)       ? deptResp.data : [];
    const fansDept = departments.find(d => /fans/i.test(d.name)) ?? departments[0];
    if (!fansDept) return res.status(500).json({ error: 'No departments found.' });
    console.log(`[user/ensure] Using dept id=${fansDept.id} name="${fansDept.name}"`);

    // 3. Create user — try each candidate endpoint/body until one succeeds.
    //    The NB API uses camelCase on some routes (vote) and snake_case on others (user responses).
    //    We probe both to handle whichever the create endpoint expects.
    // POST /user/employee — confirmed endpoint from NatureBackers backend
    const createBody = {
      first_name:     firstName.trim(),
      last_name:      lastName.trim(),
      business_email: cleanEmail,
      departmentId:   fansDept.id,
      roleId:         3,
    };
    console.log(`[user/ensure] POST /user/employee`, JSON.stringify(createBody));
    const createResp = await axios.post(
      `${NB_BASE_URL}/user/employee`,
      createBody,
      { timeout: 10_000, headers: jsonHeaders }
    );
    const newUser = createResp.data?.data ?? createResp.data;
    console.log(`[user/ensure] Created user id=${newUser?.id}`);

    return res.json({
      created:    true,
      department: fansDept.name,
      user: {
        id:        newUser?.id,
        firstName: newUser?.first_name  ?? newUser?.firstName  ?? firstName.trim(),
        lastName:  newUser?.last_name   ?? newUser?.lastName   ?? lastName.trim(),
        email:     newUser?.business_email ?? newUser?.businessEmail ?? cleanEmail,
      },
    });
  } catch (err) {
    const status  = err?.response?.status ?? 500;
    const message = err?.response?.data?.message ?? err?.response?.data?.error ?? err.message;
    console.error('[user/ensure] FAILED', { status, url: err?.config?.url, body: err?.config?.data, response: err?.response?.data });
    res.status(status).json({ error: message });
  }
});

// ── Static client (production) ────────────────────────────────────────────────

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(join(__serverDir, 'client', 'dist')));
  app.get('*', (_req, res) =>
    res.sendFile(join(__serverDir, 'client', 'dist', 'index.html'))
  );
}

// ── Startup ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

console.log('Initializing agents…');
[researchExecutor, campaignExecutor] = await Promise.all([
  initResearchAgent(),
  initCampaignAgent(),
]);
console.log('Agents ready.');

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
