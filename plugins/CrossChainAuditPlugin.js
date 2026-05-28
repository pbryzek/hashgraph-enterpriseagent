/**
 * CrossChainAuditPlugin — agent tools for cross-chain audit recording and log querying
 *
 * Tools:
 *   record_cross_chain_audit  → recordCrossChainAudit() → HCS + CLPR concurrently
 *   get_audit_logs            → in-memory log with filtering
 */

import { z } from 'zod';
import { BasePlugin, BaseHederaQueryTool } from 'hedera-agent-kit';
import { recordCrossChainAudit, getAuditLogs } from './crossChainAudit.js';

// ── record_cross_chain_audit ──────────────────────────────────────────────────

const RecordAuditSchema = z.object({
  eventType: z
    .string()
    .describe('Event category, e.g. "DONATION", "CAMPAIGN_CREATED", "VOTE_CAST".'),
  entityId: z
    .string()
    .describe('ID of the primary entity being audited (campaign ID, project ID, tx ID, etc.).'),
  actor: z
    .string()
    .describe('Identifier of the actor performing the action (account ID, email, user ID).'),
  payload: z
    .record(z.unknown())
    .describe('Arbitrary JSON object with the full event data to be hashed and attested.'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Optional labels for filtering, e.g. ["hbar", "campaign-113", "wetlands"].'),
});

class RecordCrossChainAuditTool extends BaseHederaQueryTool {
  name = 'record_cross_chain_audit';
  description =
    'Record an event simultaneously on Hedera HCS and the CLPR cross-ledger attestation network. ' +
    'Computes a SHA-256 integrity hash of the payload before both writes so either chain can detect tampering. ' +
    'Returns auditId, hcs.tx_hash, hcs.sequenceNumber, clpr.tx_hash, clpr.proofHash, and status ' +
    '(recorded / partial / failed). Use after any donation, campaign creation, or compliance event.';
  specificInputSchema = RecordAuditSchema;
  namespace = 'cross-chain-audit';

  async executeQuery({ eventType, entityId, actor, payload, tags = [] }) {
    this.logger.info(`CrossChainAudit: recording ${eventType} for entity=${entityId} actor=${actor}`);

    const result = await recordCrossChainAudit({ eventType, entityId, actor, payload, tags });
    const { auditId, hcs, clpr, summary } = result;

    const hcsLine  = hcs.error
      ? `HCS:  FAILED — ${hcs.error}`
      : `HCS:  tx_hash=${hcs.tx_hash}  seq#=${hcs.sequenceNumber}${hcs.simulated ? '  (simulated)' : ''}`;

    const clprLine = clpr.error
      ? `CLPR: FAILED — ${clpr.error}`
      : `CLPR: tx_hash=${clpr.tx_hash}  proofHash=${clpr.proofHash}${clpr.simulated ? '  (simulated)' : ''}`;

    return [
      `Cross-Chain Audit — ${summary.status.toUpperCase()}`,
      `Audit ID:       ${auditId}`,
      `Integrity hash: ${summary.integrityHash}`,
      `Event type:     ${eventType}`,
      `Entity:         ${entityId}`,
      `Actor:          ${actor}`,
      `Timestamp:      ${summary.timestamp}`,
      '',
      hcsLine,
      clprLine,
    ].join('\n');
  }
}

// ── get_audit_logs ────────────────────────────────────────────────────────────

const GetAuditLogsSchema = z.object({
  eventType: z.string().optional().describe('Filter by event type, e.g. "DONATION".'),
  entityId:  z.string().optional().describe('Filter by entity ID.'),
  actor:     z.string().optional().describe('Filter by actor identifier.'),
  status:    z.enum(['recorded', 'partial', 'failed']).optional().describe('Filter by audit status.'),
  tag:       z.string().optional().describe('Filter by a single tag label.'),
});

class GetAuditLogsTool extends BaseHederaQueryTool {
  name = 'get_audit_logs';
  description =
    'Query the in-memory cross-chain audit log. ' +
    'Filter by eventType, entityId, actor, status (recorded/partial/failed), or tag. ' +
    'Returns all matching audit entries with HCS and CLPR hashes.';
  specificInputSchema = GetAuditLogsSchema;
  namespace = 'cross-chain-audit';

  async executeQuery(filters) {
    this.logger.info(`CrossChainAudit: get_audit_logs filters=${JSON.stringify(filters)}`);

    const entries = getAuditLogs(filters);
    if (entries.length === 0) return 'No audit log entries match the given filters.';

    const lines = entries.map((e, i) => {
      const hcsLine  = e.hcs?.error
        ? `  HCS:  FAILED — ${e.hcs.error}`
        : `  HCS:  ${e.hcs?.tx_hash ?? '?'}${e.hcs?.simulated ? ' (sim)' : ''}`;
      const clprLine = e.clpr?.error
        ? `  CLPR: FAILED — ${e.clpr.error}`
        : `  CLPR: ${e.clpr?.tx_hash ?? '?'}${e.clpr?.simulated ? ' (sim)' : ''}`;

      return [
        `${i + 1}. [${e.status?.toUpperCase() ?? '?'}] ${e.eventType}  entity=${e.entityId}  actor=${e.actor}`,
        `  Audit ID:  ${e.auditId}`,
        `  Integrity: ${e.integrityHash}`,
        `  Time:      ${e.timestamp}`,
        hcsLine,
        clprLine,
        e.tags?.length ? `  Tags: ${e.tags.join(', ')}` : null,
      ].filter(Boolean).join('\n');
    });

    return `${entries.length} audit log entry/entries:\n\n${lines.join('\n\n')}`;
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class CrossChainAuditPlugin extends BasePlugin {
  id      = 'cross-chain-audit-plugin';
  name    = 'Cross-Chain Audit Plugin';
  description =
    'Records compliance events simultaneously on Hedera HCS and the CLPR cross-ledger network; ' +
    'queries the in-memory audit log';
  version = '1.0.0';
  author  = 'CarbonSustain';

  #tools = [];

  async initialize(context) {
    await super.initialize(context);
    this.#tools = [
      new RecordCrossChainAuditTool({ hederaKit: context.config.hederaKit, logger: context.logger }),
      new GetAuditLogsTool(          { hederaKit: context.config.hederaKit, logger: context.logger }),
    ];
  }

  getTools() { return this.#tools; }
}
