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
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { initResearchAgent, initCampaignAgent } from './agent.js';

const NB_BASE_URL = 'https://d3chyxfaxhbtc9.cloudfront.net';

const app = express();
app.use(express.json());
app.use(cors());

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

app.post('/api/agent', async (req, res) => {
  const { message, chatHistory = [], phase = 'research' } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  const executor = phase === 'campaign' ? campaignExecutor : researchExecutor;

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

    const langchainHistory = chatHistory.flatMap(({ role, content }) => {
      if (role === 'user') return [new HumanMessage(content)];
      if (role === 'assistant') return [new AIMessage(content)];
      return [];
    });

    const result = await executor.invoke(
      { input: message, chat_history: langchainHistory },
      {
        callbacks: [
          {
            handleToolStart(tool, _input, _runId, _parentRunId, _tags, _metadata, runName) {
              const name = tool?.name ?? runName ?? 'tool';
              currentToolName = name;
              send({ type: 'tool_start', step: `Calling ${name}…` });
            },
            handleToolEnd(rawOutput) {
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
                      send({ type: 'approval_request', campaignPreview: preview });
                    }
                  } catch { /* not JSON, ignore */ }
                }

                // Detect HashPack payment request — check rawOutput directly
                if (rawOutput && typeof rawOutput === 'string' && rawOutput.includes('hashpack_payment_request')) {
                  try {
                    const payment = JSON.parse(rawOutput);
                    if (payment?.__type === 'hashpack_payment_request') {
                      pendingPayment = payment;
                      send({ type: 'hashpack_payment', payment });
                    }
                  } catch { /* not JSON */ }
                }
              } catch {
                toolOutputs.push(rawOutput);
              }
              send({ type: 'tool_end', step: 'Tool completed' });
            },
            handleLLMStart() {
              send({ type: 'llm_start', step: 'Agent thinking…' });
            },
          },
        ],
      }
    );

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
    });
  } catch (err) {
    console.error('Agent error:', err);
    send({ type: 'error', error: err.message });
  } finally {
    res.end();
  }
});

// ── Static client (production) ────────────────────────────────────────────────

if (process.env.NODE_ENV === 'production') {
  const { createRequire } = await import('module');
  const { fileURLToPath } = await import('url');
  const path = await import('path');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.join(__dirname, 'client', 'dist')));
  app.get('*', (_req, res) =>
    res.sendFile(path.join(__dirname, 'client', 'dist', 'index.html'))
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
