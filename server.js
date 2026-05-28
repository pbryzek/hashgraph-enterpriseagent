/**
 * server.js — Express backend for CarbonSustain Hedera agent
 *
 * POST /api/agent  — SSE stream of agent steps + final result with tx IDs
 * GET  /health     — liveness check for Cloud Run
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { initResearchAgent, initCampaignAgent } from './agent.js';

const app = express();
app.use(express.json());
app.use(cors());

let researchExecutor;
let campaignExecutor;

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

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
  const toolOutputs = []; // collect tool results to recover from empty LLM summaries

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
              send({ type: 'tool_start', step: `Calling ${name}…` });
            },
            handleToolEnd(rawOutput) {
              try {
                const parsed = JSON.parse(rawOutput);
                // hedera-agent-kit wraps results as { success, data }
                const text = parsed?.data ?? parsed?.output ?? rawOutput;
                toolOutputs.push(typeof text === 'string' ? text : JSON.stringify(text));
                if (parsed.transactionId) txIds.push(parsed.transactionId);
                if (parsed.receipt?.transactionId)
                  txIds.push(String(parsed.receipt.transactionId));
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

    // Gemini-flash-lite sometimes returns 0 tokens after tool execution.
    // Rather than retrying (which would re-run write tools), surface the
    // collected tool outputs directly as the response.
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

    // If Gemini returned nothing after tool calls, show the tool results directly
    if (!output && toolOutputs.length > 0) {
      output = toolOutputs.join('\n\n---\n\n');
    }

    send({
      type: 'done',
      output,
      txIds: [...new Set(txIds)],
      phase,
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
