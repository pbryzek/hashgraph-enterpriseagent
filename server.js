/**
 * server.js — Express backend for CarbonSustain Hedera agent
 *
 * POST /api/agent  — SSE stream of agent steps + final result with tx IDs
 * GET  /health     — liveness check for Cloud Run
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initAgent } from './agent.js';

const app = express();
app.use(express.json());
app.use(cors());

let executor;

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Agent endpoint (SSE) ──────────────────────────────────────────────────────

app.post('/api/agent', async (req, res) => {
  const { message, chatHistory = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const txIds = [];

  try {
    send({ type: 'status', step: 'Agent started…' });

    const langchainHistory = chatHistory.flatMap(({ role, content }) => {
      if (role === 'user') return [{ type: 'human', content }];
      if (role === 'assistant') return [{ type: 'ai', content }];
      return [];
    });

    const result = await executor.invoke(
      { input: message, chat_history: langchainHistory },
      {
        callbacks: [
          {
            handleToolStart(_tool, _input, _runId, _parentRunId, _tags, _metadata, toolName) {
              send({ type: 'tool_start', step: `Calling ${toolName}…` });
            },
            handleToolEnd(output) {
              try {
                const parsed = JSON.parse(output);
                if (parsed.transactionId) txIds.push(parsed.transactionId);
                if (parsed.receipt?.transactionId)
                  txIds.push(String(parsed.receipt.transactionId));
              } catch {
                // output is not JSON; ignore
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

    send({
      type: 'done',
      output: result.output,
      txIds: [...new Set(txIds)],
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

console.log('Initializing Hedera agent…');
executor = await initAgent();
console.log('Agent ready.');

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
