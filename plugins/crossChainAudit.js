/**
 * crossChainAudit.js — shared utility
 *
 * recordCrossChainAudit()
 *   ├── writeToHCS()        → TopicMessageSubmitTransaction → tx_hash + sequenceNumber
 *   ├── submitCLPRRecord()  → CLPR /messages POST           → tx_hash + proofHash
 *   └── builds AuditResult → { auditId, hcs, clpr, summary }
 *
 * Both run concurrently via Promise.allSettled so HCS-success + CLPR-failure
 * yields status="partial" rather than throwing.
 *
 * CLPR simulation — CLPR_SIMULATE=true (or no CLPR_API_KEY) produces a
 * deterministic simulated tx_hash for demos without live CLPR beta access.
 *
 * Env vars:
 *   AUDIT_HCS_TOPIC_ID    — HCS topic (also accepts AUDIT_TOPIC_ID; auto-simulated if blank)
 *   CLPR_ENDPOINT_URL     — e.g. https://clpr-beta.hashgraph.com/v1
 *   CLPR_API_KEY          — leave blank to simulate
 *   CLPR_SIMULATE=true    — force simulation even with a key
 */

import { createHash, randomUUID } from 'crypto';
import { Client, PrivateKey, TopicMessageSubmitTransaction } from '@hashgraph/sdk';
import axios from 'axios';

// ── In-memory audit log ───────────────────────────────────────────────────────

const auditLog = [];

export function storeAuditSummary(entry) {
  auditLog.push(entry);
}

// ── HCS message compactor ─────────────────────────────────────────────────────
// HCS messages have a ~1024-byte limit; chunked messages break JSON parsing on
// the mirror node API. Strip large arrays from the payload when over budget.

function compactForHCS(envelope) {
  const MAX_BYTES = 950;
  const msg = JSON.stringify(envelope);
  if (Buffer.byteLength(msg, 'utf8') <= MAX_BYTES) return envelope;

  const compacted = JSON.parse(msg);
  const p = compacted.payload;
  if (p) {
    if (Array.isArray(p.voteHashes) && p.voteHashes.length > 0) {
      p.voteHashes = { count: p.voteHashes.length, note: 'hashes omitted — verify via merkleRoot' };
    }
    if (Array.isArray(p.projects)) {
      p.projects = p.projects.map(pr => ({ projectId: pr.projectId, projectName: pr.projectName, votes: pr.votes }));
    }
    if (typeof p.note === 'string' && p.note.length > 150) p.note = p.note.slice(0, 150) + '…';
    if (typeof p.emailBody === 'string') delete p.emailBody;
  }
  compacted._hcsCompacted = true;

  const msg2 = JSON.stringify(compacted);
  if (Buffer.byteLength(msg2, 'utf8') <= MAX_BYTES) return compacted;

  // Still too large — strip remaining large fields
  if (compacted.payload) {
    delete compacted.payload.projectTally;
    delete compacted.payload.projects;
  }
  return compacted;
}

/**
 * @param {{ eventType?, entityId?, actor?, status?, tag? }} filters
 */
export function getAuditLogs({ eventType, entityId, actor, status, tag } = {}) {
  return auditLog.filter(e => {
    if (eventType && e.eventType !== eventType) return false;
    if (entityId  && e.entityId  !== entityId)  return false;
    if (actor     && e.actor     !== actor)      return false;
    if (status    && e.summary?.status !== status) return false;
    if (tag       && !e.tags?.includes(tag))     return false;
    return true;
  });
}

// ── Hedera client factory (same pattern as CarbonPaymentPlugin) ───────────────

function getHederaClient() {
  const network = (process.env.HEDERA_NETWORK || 'testnet').toLowerCase();
  const client  = network === 'mainnet' ? Client.forMainnet() : Client.forTestnet();
  const rawKey  = process.env.HEDERA_PRIVATE_KEY || '';
  const pk = rawKey.startsWith('0x')
    ? PrivateKey.fromStringECDSA(rawKey)
    : PrivateKey.fromString(rawKey);
  client.setOperator(process.env.HEDERA_ACCOUNT_ID, pk);
  return client;
}

// ── HCS write ─────────────────────────────────────────────────────────────────

async function writeToHCS(payload, integrityHash) {
  const topicId = process.env.AUDIT_HCS_TOPIC_ID || process.env.AUDIT_TOPIC_ID;
  const envelope = compactForHCS({ ...payload, integrityHash });
  const message = JSON.stringify(envelope);

  if (!topicId) {
    return {
      tx_hash:        `sim@${Date.now()}`,
      sequenceNumber: 0,
      simulated:      true,
    };
  }

  const client = getHederaClient();
  try {
    const tx      = await new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(message)
      .setMaxChunks(10)
      .execute(client);
    const receipt = await tx.getReceipt(client);

    return {
      tx_hash:        tx.transactionId.toString(),
      sequenceNumber: receipt.topicSequenceNumber?.toNumber() ?? 0,
    };
  } finally {
    client.close();
  }
}

// ── CLPR write ────────────────────────────────────────────────────────────────

async function submitCLPRRecord(payload, integrityHash) {
  const simulate = process.env.CLPR_SIMULATE === 'true' || !process.env.CLPR_API_KEY;

  if (simulate) {
    const simHash = '0xclpr_sim_' +
      createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 40);
    return {
      tx_hash:   simHash,
      proofHash: integrityHash,
      simulated: true,
    };
  }

  const resp = await axios.post(
    `${process.env.CLPR_ENDPOINT_URL}/messages`,
    { ...payload, integrityHash },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.CLPR_API_KEY}`,
      },
      timeout: 15_000,
    }
  );

  return {
    tx_hash:   resp.data?.tx_hash ?? resp.data?.transactionHash,
    proofHash: resp.data?.proofHash ?? integrityHash,
  };
}

// ── recordCrossChainAudit — main export ───────────────────────────────────────

/**
 * @param {{
 *   eventType: string,
 *   entityId:  string,
 *   actor:     string,
 *   payload:   object,
 *   tags?:     string[]
 * }} opts
 * @returns {Promise<{ auditId, hcs, clpr, summary }>}
 */
export async function recordCrossChainAudit({ eventType, entityId, actor, payload, tags = [] }) {
  const auditId       = randomUUID();
  const integrityHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  const [hcsSettled, clprSettled] = await Promise.allSettled([
    writeToHCS(       { eventType, entityId, actor, payload, tags, auditId }, integrityHash),
    submitCLPRRecord( { eventType, entityId, actor, payload, tags, auditId }, integrityHash),
  ]);

  const hcs  = hcsSettled.status  === 'fulfilled' ? hcsSettled.value  : { error: hcsSettled.reason?.message  };
  const clpr = clprSettled.status === 'fulfilled' ? clprSettled.value : { error: clprSettled.reason?.message };

  const bothOk = hcsSettled.status  === 'fulfilled' && clprSettled.status === 'fulfilled';
  const noneOk = hcsSettled.status  === 'rejected'  && clprSettled.status === 'rejected';
  const status = bothOk ? 'recorded' : noneOk ? 'failed' : 'partial';

  const summary = {
    auditId,
    integrityHash,
    status,
    eventType,
    entityId,
    actor,
    tags,
    timestamp: new Date().toISOString(),
  };

  storeAuditSummary({ ...summary, hcs, clpr, payload });

  return { auditId, hcs, clpr, summary };
}
