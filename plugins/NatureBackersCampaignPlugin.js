/**
 * NatureBackersCampaignPlugin — creates and manages Nature Backers campaigns
 * via the Nature Backers REST API at https://d3chyxfaxhbtc9.cloudfront.net
 *
 * Campaign status IDs (from GET /campaign-status):
 *   1 = Created   — just created, not yet started
 *   2 = Active    — within startDate/endDate window, voting open
 *   3 = Pending   — endDate passed, awaiting admin approval
 *   4 = Rejected  — rejected by admin
 *   5 = Approved  — approved; votes pushed to Hedera
 *   6 = Cancelled — cancelled (no votes or manually cancelled)
 *
 * Tools:
 *   nb_preview_campaign       →  Show campaign preview and wait for user approval
 *   nb_get_campaign_statuses  →  GET  /campaign-status
 *   nb_get_departments        →  GET  /department
 *   nb_create_campaign        →  POST /campaign  (multipart/form-data)
 *   nb_get_campaigns          →  GET  /campaign  (optional statusId filter)
 *   nb_get_campaign           →  GET  /campaign/:id  (full detail incl. projects + departments)
 *   nb_search_projects        →  GET  /project  (search NB projects by keyword, returns integer IDs)
 *   nb_assign_projects        →  POST /campaign-project/assign
 *   nb_get_campaign_votes     →  GET  /vote/campaign-votes/:id  (all votes with user + project)
 *   nb_get_hedera_votes       →  GET  /vote/hedera/:id          (votes from Hedera chain)
 *   nb_get_vote_proof         →  GET  /vote/proof/:id           (Merkle proof)
 *   nb_push_votes_to_hedera   →  POST /vote/hedera/:id          (push approved votes on-chain)
 *   nb_record_campaign_report →  Compile final report and submit to HCS
 *   nb_get_campaign_hcs_report→  Retrieve HCS-recorded campaign reports (in-memory + mirror)
 *   nb_get_hcs_records        →  Retrieve ALL HCS records from mirror node (optionally filter by campaignId)
 *   nb_get_votes_by_campaign  →  GET  /campaign/:id + Hedera mirror (decode on-chain tx)
 */

import axios from 'axios';
import { z } from 'zod';
import { BasePlugin, BaseHederaQueryTool } from 'hedera-agent-kit';
import FormData from 'form-data';
import { recordCrossChainAudit, getAuditLogs } from './crossChainAudit.js';
import PDFDocument from 'pdfkit';

const NB_BASE_URL      = 'https://d3chyxfaxhbtc9.cloudfront.net';
const MAINNET_INDEXER  = 'https://indexer.guardianservice.app/api/v1/mainnet';

function indexerLink(consensusTimestamp) {
  if (!consensusTimestamp) return null;
  return `/indexer/${encodeURIComponent(consensusTimestamp)}`;
}

// ── Hedera mirror node helpers ─────────────────────────────────────────────────

function mirrorNodeBase() {
  const network = (process.env.HEDERA_NETWORK || 'testnet').toLowerCase();
  return network === 'mainnet'
    ? 'https://mainnet-public.mirrornode.hedera.com'
    : 'https://testnet.mirrornode.hedera.com';
}

/**
 * ABI-decode the 5-param vote contract call:
 *   castVote(string campaignKey, uint256 departmentId, string voterEmail, uint256 reserved, string voteJson)
 */
function decodeVoteParams(functionParams) {
  if (!functionParams || functionParams.length < 10) return null;
  const data = (functionParams.startsWith('0x') ? functionParams.slice(2) : functionParams).slice(8);

  function uint256AtByte(byteOffset) {
    const h = byteOffset * 2;
    return Number(BigInt('0x' + data.slice(h, h + 64)));
  }
  function stringAtByteOffset(byteOffset) {
    const h = byteOffset * 2;
    const len = Number(BigInt('0x' + data.slice(h, h + 64)));
    return Buffer.from(data.slice(h + 64, h + 64 + len * 2), 'hex').toString('utf8');
  }

  try {
    const off0  = uint256AtByte(0);
    const deptId = uint256AtByte(32);
    const off2  = uint256AtByte(64);
    const off4  = uint256AtByte(128);
    const campaignKey = stringAtByteOffset(off0);
    const voterEmail  = stringAtByteOffset(off2);
    const rawJson     = stringAtByteOffset(off4);
    let vote = null;
    try { vote = JSON.parse(rawJson); } catch { /* leave null */ }
    return { campaignKey, departmentId: deptId, voterEmail, vote };
  } catch {
    return null;
  }
}

// ── Shared formatters ─────────────────────────────────────────────────────────

function fmtCampaignProjects(campaignProjects) {
  if (!Array.isArray(campaignProjects) || campaignProjects.length === 0) return '    (none)';
  return campaignProjects.map(cp => {
    const p   = cp.project ?? {};
    const url = indexerLink(p.consensusTimestamp);
    return [
      `    - CampaignProject ID: ${cp.id}  Project ID: ${cp.projectId}`,
      p.projectName ? `      Name:        ${p.projectName}` : null,
      p.projectTypes ? `      Type:        ${p.projectTypes}` : null,
      p.projectMethodology ? `      Methodology: ${p.projectMethodology}` : null,
      p.standards?.carbonStandard ? `      Standard:    ${p.standards.carbonStandard}` : null,
      p.status ? `      Status:      ${p.status}` : null,
      url ? `      🔗 Indexer: [Verify on Guardian Mainnet](${url})` : null,
    ].filter(Boolean).join('\n');
  }).join('\n');
}

function fmtCampaignDepartments(campaignDepts) {
  if (!Array.isArray(campaignDepts) || campaignDepts.length === 0) return '    (none)';
  return campaignDepts.map(cd => {
    const d = cd.department ?? {};
    return `    - Dept ID: ${cd.departmentId}  Name: ${d.name ?? '?'}`;
  }).join('\n');
}

function fmtCampaignSummary(c) {
  const statusName = c.campaignStatus?.name ?? `ID ${c.campaignStatusId ?? '?'}`;
  const votesInfo  = Array.isArray(c.votes)
    ? `${c.votes.length} vote(s)${c.votes.some(v => v.vote_hash) ? ' (some on-chain)' : ''}`
    : '(not loaded)';

  return [
    `ID:            ${c.id}`,
    `Name:          ${c.name}`,
    `Status:        ${statusName} (ID: ${c.campaignStatusId ?? '?'})`,
    `Voting Style:  ${c.votingStyle ?? '?'}`,
    `Start → End:   ${c.startDate} → ${c.endDate}`,
    `Created:       ${c.createdAt}  Updated: ${c.updatedAt}`,
    `URL:           ${c.url ?? '(none)'}`,
    `Email Subject: ${c.emailSubject ?? '(none)'}`,
    `Email Body:    ${c.emailBody ?? '(none)'}`,
    `tx_hash:       ${c.tx_hash ?? '(none)'}`,
    `Votes:         ${votesInfo}`,
    `Departments:\n${fmtCampaignDepartments(c.CampaignDepartment)}`,
    `Projects:\n${fmtCampaignProjects(c.CampaignProject)}`,
  ].join('\n');
}

// ── Defaults ──────────────────────────────────────────────────────────────────

function defaultStartDate() {
  const d = new Date();
  d.setMinutes(d.getMinutes() + 1);
  return d.toISOString();
}
function defaultEndDate(startIso) {
  const d = new Date(startIso);
  d.setHours(d.getHours() + 1);
  return d.toISOString();
}

// ── gatherCampaignRecords (exported for on-demand PDF route in server.js) ─────
// Merges in-memory audit log + Hedera mirror node records for a campaign.
// Returns a normalised array: { source, auditId, eventType, entityId, actor,
//   tags, payload, timestamp, hcsSeq?, hcsTx? }
// Mirror node is authoritative; in-memory fills gaps (propagation lag / simulated HCS).

export async function gatherCampaignRecords(campaignId, limit = 100, mirrorTimeoutMs = 20_000) {
  const topicId = process.env.AUDIT_HCS_TOPIC_ID || process.env.AUDIT_TOPIC_ID;

  // ── 1. In-memory ─────────────────────────────────────────────────────────────
  const allMem = getAuditLogs({});
  const memEntries = allMem.filter(e =>
    e.entityId === `campaign-${campaignId}` ||
    (e.tags ?? []).includes(`campaign-${campaignId}`)
  ).map(e => ({
    source:    'memory',
    auditId:   e.auditId,
    eventType: e.eventType,
    entityId:  e.entityId,
    actor:     e.actor,
    tags:      e.tags ?? [],
    payload:   e.payload ?? {},
    timestamp: e.timestamp,
  }));

  // ── 2. Mirror node ────────────────────────────────────────────────────────────
  let mirrorEntries = [];
  if (topicId) {
    try {
      const resp = await axios.get(
        `${mirrorNodeBase()}/api/v1/topics/${topicId}/messages`,
        { params: { limit }, timeout: mirrorTimeoutMs }
      );
      const msgs = resp.data?.messages ?? [];
      mirrorEntries = msgs.map(m => {
        try {
          const parsed = JSON.parse(Buffer.from(m.message, 'base64').toString('utf8'));
          const campaignMatch =
            parsed.entityId === `campaign-${campaignId}` ||
            parsed.payload?.campaignId === campaignId ||
            (parsed.tags ?? []).includes(`campaign-${campaignId}`);
          if (!campaignMatch) return null;
          return {
            source:    'mirror',
            auditId:   parsed.auditId,
            eventType: parsed.eventType,
            entityId:  parsed.entityId,
            actor:     parsed.actor,
            tags:      parsed.tags ?? [],
            payload:   parsed.payload ?? {},
            timestamp: parsed.timestamp ?? m.consensus_timestamp,
            hcsSeq:    m.sequence_number,
            hcsTx:     m.consensus_timestamp,
          };
        } catch { return null; }
      }).filter(Boolean);
    } catch { /* mirror unavailable — use in-memory only */ }
  }

  // ── 3. Deduplicate — mirror wins on auditId collision ────────────────────────
  const mirrorAuditIds = new Set(mirrorEntries.map(r => r.auditId).filter(Boolean));
  const memOnly = memEntries.filter(e => !mirrorAuditIds.has(e.auditId));

  return [...mirrorEntries, ...memOnly];
}

// ── fetchVotesForCampaign ─────────────────────────────────────────────────────
// Centralised vote resolver used by RecordCampaignReportTool and
// GetCampaignHcsReportTool.  Strategy:
//   1. Use provided userId, or fall back to NB_ADMIN_USER_ID env var (default 1)
//   2. If both /vote/campaign-votes and /vote/hedera return 0 votes,
//      fall back to campaign.votes embedded in the campaign object (populated
//      when the campaign is fetched from /campaign/:id)
// This handles the common case where the caller omits userId but votes exist.

async function fetchVotesForCampaign(campaignId, userId, campaign) {
  const effectiveUserId = userId ?? Number(process.env.NB_ADMIN_USER_ID ?? 1);
  const voteParams = { userId: effectiveUserId };

  const [dbVotesResp, hederaVotesResp, proofResp] = await Promise.allSettled([
    axios.get(`${NB_BASE_URL}/vote/campaign-votes/${campaignId}`, { params: voteParams, timeout: 15_000 }),
    axios.get(`${NB_BASE_URL}/vote/hedera/${campaignId}`,         { params: voteParams, timeout: 20_000 }),
    axios.get(`${NB_BASE_URL}/vote/proof/${campaignId}`,          { params: voteParams, timeout: 20_000 }),
  ]);

  const dbVoteData     = dbVotesResp.status     === 'fulfilled' ? (dbVotesResp.value.data?.data     ?? dbVotesResp.value.data)     : null;
  const hederaVoteData = hederaVotesResp.status === 'fulfilled' ? (hederaVotesResp.value.data?.data ?? hederaVotesResp.value.data) : null;
  const proofData      = proofResp.status       === 'fulfilled' ? (proofResp.value.data?.data       ?? proofResp.value.data)       : null;

  let dbVotes     = dbVoteData?.votes     ?? [];
  let hederaVotes = hederaVoteData?.votes ?? [];
  const merkleRoot  = proofData?.merkleRoot ?? null;
  const merkleVotes = proofData?.votes      ?? [];

  // Fallback: use votes embedded in the campaign object when the dedicated
  // endpoints returned nothing (e.g. auth failure without userId).
  // Build a projectId → projectName map from CampaignProject for name lookup.
  if (dbVotes.length === 0 && hederaVotes.length === 0 && Array.isArray(campaign?.votes) && campaign.votes.length > 0) {
    const projNameMap = Object.fromEntries(
      (campaign.CampaignProject ?? []).map(cp => [
        cp.projectId,
        cp.project?.projectName ?? `Project ${cp.projectId}`,
      ])
    );
    dbVotes = campaign.votes.map(v => ({
      ...v,
      project: v.project ?? { projectName: projNameMap[v.projectId] ?? `Project ${v.projectId}` },
    }));
  }

  return { dbVotes, hederaVotes, merkleRoot, merkleVotes };
}

// ── Shared campaign schema ─────────────────────────────────────────────────────

const CampaignSchema = z.object({
  name:         z.string().describe('Unique campaign name.'),
  votingStyle:  z.enum(['TOKEN_BASED', 'STORY_FEATURE', 'THEMED_BADGES']).optional()
                 .describe('Voting style. Defaults to STORY_FEATURE.'),
  startDate:    z.string().optional().describe('ISO 8601 start date. Defaults to 1 minute from now.'),
  endDate:      z.string().optional().describe('ISO 8601 end date. Defaults to 1 hour after startDate.'),
  emailSubject: z.string().optional().describe('Campaign invitation email subject.'),
  emailBody:    z.string().optional().describe('Campaign invitation email body.'),
  departmentIds: z.array(z.number().int().min(1)).optional()
                  .describe('Department IDs to include. Call nb_get_departments first. Defaults to [12].'),
  imageUrl:     z.string().optional().describe('Public image URL for the campaign banner. Only provide if you have a real, publicly accessible URL. Omit if uncertain — a placeholder will be used automatically.'),
  projectIds:   z.array(z.number().int().min(1)).min(1).max(3).optional()
                  .describe('NB integer project IDs to assign immediately after creation (1–3). Pass the confirmed project IDs here so assignment is atomic. If omitted, call nb_assign_projects separately.'),
});

// ── nb_preview_campaign ───────────────────────────────────────────────────────

class PreviewCampaignTool extends BaseHederaQueryTool {
  name = 'nb_preview_campaign';
  description =
    'Show a campaign preview to the user and request their approval BEFORE creating it. ' +
    'ALWAYS call this tool before nb_create_campaign. ' +
    'Returns a structured preview the user must approve. Only proceed with nb_create_campaign after receiving APPROVE.';
  specificInputSchema = CampaignSchema;
  namespace = 'nature-backers-campaign';

  async executeQuery({ name, votingStyle, startDate, endDate, emailSubject, emailBody, departmentIds, imageUrl }) {
    const resolvedStyle   = votingStyle   ?? 'STORY_FEATURE';
    const resolvedStart   = startDate     ?? defaultStartDate();
    const resolvedEnd     = endDate       ?? defaultEndDate(resolvedStart);
    const resolvedDeptIds = departmentIds ?? [12];

    this.logger.info(`NB preview_campaign "${name}"`);

    const preview = {
      __type:       'campaign_preview',
      name,
      votingStyle:  resolvedStyle,
      startDate:    resolvedStart,
      endDate:      resolvedEnd,
      emailSubject: emailSubject ?? null,
      emailBody:    emailBody    ?? null,
      departmentIds: resolvedDeptIds,
      imageUrl:     imageUrl     ?? null,
    };

    return JSON.stringify(preview);
  }
}

// ── nb_get_campaign_statuses ──────────────────────────────────────────────────

class GetCampaignStatusesTool extends BaseHederaQueryTool {
  name = 'nb_get_campaign_statuses';
  description =
    'Fetch the live list of all campaign status IDs and names. ' +
    '1=Created, 2=Active (voting open), 3=Pending (awaiting approval), ' +
    '4=Rejected, 5=Approved (votes on Hedera), 6=Cancelled. ' +
    'Call before filtering campaigns by status to confirm current IDs.';
  specificInputSchema = z.object({});
  namespace = 'nature-backers-campaign';

  async executeQuery() {
    this.logger.info('NB get_campaign_statuses');
    const resp  = await axios.get(`${NB_BASE_URL}/campaign-status`, { timeout: 15_000 });
    const items = resp.data?.data ?? resp.data ?? [];
    if (!Array.isArray(items) || items.length === 0) return 'No campaign statuses found.';

    const lines = items.map(s => `  ${s.id}: ${s.name}`);
    return (
      `Campaign statuses:\n${lines.join('\n')}\n\n` +
      `Lifecycle: Created(1) → Active(2) → Pending(3) → Approved(5)\n` +
      `                                              ↘ Rejected(4)\n` +
      `           Created/Active                    → Cancelled(6)`
    );
  }
}

// ── nb_get_departments ────────────────────────────────────────────────────────

class GetDepartmentsTool extends BaseHederaQueryTool {
  name = 'nb_get_departments';
  description =
    'List all departments and their IDs. Call before nb_create_campaign to get valid departmentIds. ' +
    'Set withEmployees=true to also return the users assigned to each department.';
  specificInputSchema = z.object({
    withEmployees: z.boolean().optional().describe('Include user list per department (default false).'),
  });
  namespace = 'nature-backers-campaign';

  async executeQuery({ withEmployees = false } = {}) {
    this.logger.info('NB get_departments');
    const resp  = await axios.get(`${NB_BASE_URL}/department`, {
      params: withEmployees ? { withEmployees: 'true' } : {},
      timeout: 15_000,
    });
    const items = resp.data?.data ?? resp.data ?? [];
    if (!Array.isArray(items) || items.length === 0) return 'No departments found.';

    const lines = items.map(d => {
      const userCount = Array.isArray(d.users) ? `  (${d.users.length} employee(s))` : '';
      let line = `  ID ${d.id}: ${d.name}${userCount}`;
      if (withEmployees && Array.isArray(d.users) && d.users.length > 0) {
        const employees = d.users.map(u => `      - ${u.first_name} ${u.last_name} <${u.business_email}>`).join('\n');
        line += `\n${employees}`;
      }
      return line;
    });
    return `Departments (use these IDs in nb_create_campaign):\n${lines.join('\n')}`;
  }
}

// ── nb_create_campaign ────────────────────────────────────────────────────────

class CreateCampaignTool extends BaseHederaQueryTool {
  name = 'nb_create_campaign';
  description =
    'Create a new Nature Backers sustainability campaign. ' +
    'ONLY call this AFTER nb_preview_campaign has been shown AND the user has explicitly said APPROVE. ' +
    'Returns the new campaign ID, voting URL, and a QR code the user can scan to vote.';
  specificInputSchema = CampaignSchema;
  namespace = 'nature-backers-campaign';

  async executeQuery({ name, votingStyle, startDate, endDate, emailSubject, emailBody, departmentIds, imageUrl, projectIds }) {
    const resolvedStyle   = votingStyle   ?? 'STORY_FEATURE';
    const resolvedStart   = startDate     ?? defaultStartDate();
    const resolvedEnd     = endDate       ?? defaultEndDate(resolvedStart);
    const resolvedDeptIds = departmentIds ?? [12];

    this.logger.info(`NB create_campaign "${name}" style=${resolvedStyle} projectIds=${JSON.stringify(projectIds ?? [])}`);

    const form = new FormData();
    form.append('name', name);
    form.append('votingStyle', resolvedStyle);
    form.append('startDate', resolvedStart);
    form.append('endDate', resolvedEnd);
    if (emailSubject) form.append('emailSubject', emailSubject);
    if (emailBody)    form.append('emailBody', emailBody);
    form.append('departmentIds', JSON.stringify(resolvedDeptIds));

    const placeholder = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );

    if (imageUrl) {
      try {
        const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 10_000 });
        const contentType = imgResp.headers['content-type'] || 'image/png';
        const ext = contentType.split('/')[1] || 'png';
        form.append('file', Buffer.from(imgResp.data), { filename: `campaign-banner.${ext}`, contentType });
      } catch {
        this.logger.warn(`NB create_campaign: could not fetch imageUrl "${imageUrl}" — using placeholder`);
        form.append('file', placeholder, { filename: 'placeholder.png', contentType: 'image/png' });
      }
    } else {
      form.append('file', placeholder, { filename: 'placeholder.png', contentType: 'image/png' });
    }

    const resp     = await axios.post(`${NB_BASE_URL}/campaign`, form, {
      headers: form.getHeaders(),
      timeout: 20_000,
    });
    const campaign = resp.data?.data ?? resp.data;
    const id       = campaign?.id ?? '?';
    const statusName = campaign?.campaignStatus?.name ?? `ID ${campaign?.campaignStatusId}`;
    const depts    = fmtCampaignDepartments(campaign?.CampaignDepartment);

    const frontendUrl = (process.env.NATURE_BACKERS_FRONTEND_URL || 'https://main.d2falv1xg02otc.amplifyapp.com').replace(/\/$/, '');
    const votingUrl   = `${frontendUrl}/auth/signin/?campaignId=${id}`;
    const qrCodeUrl   = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(votingUrl)}`;

    // Record campaign creation on HCS — failure here must never block the campaign response
    let hcsLine = 'HCS: skipped (audit error)';
    let auditId = '(audit unavailable)';
    try {
      const audit = await recordCrossChainAudit({
        eventType: 'CAMPAIGN_CREATED',
        entityId:  `campaign-${id}`,
        actor:     'agent',
        payload: {
          campaignId: id,
          name,
          votingStyle: resolvedStyle,
          startDate:   resolvedStart,
          endDate:     resolvedEnd,
          departmentIds: resolvedDeptIds,
          votingUrl,
          timestamp: new Date().toISOString(),
        },
        tags: ['campaign', `campaign-${id}`, 'creation'],
      });
      auditId = audit.summary?.auditId ?? '(none)';
      hcsLine = audit.hcs?.simulated
        ? `HCS: simulated (set AUDIT_HCS_TOPIC_ID to record on-chain)`
        : `HCS: tx=${audit.hcs?.tx_hash}  seq#=${audit.hcs?.sequenceNumber}`;
    } catch (auditErr) {
      this.logger.warn(`NB create_campaign: HCS audit failed — ${auditErr.message}`);
    }

    // Auto-assign projects if provided — atomic with campaign creation
    let assignLine = '';
    if (projectIds && projectIds.length > 0) {
      try {
        const assignResp = await axios.post(
          `${NB_BASE_URL}/campaign-project/assign`,
          { campaignId: id, projectIds },
          { headers: { 'Content-Type': 'application/json' }, timeout: 15_000 }
        );
        const aData = assignResp.data?.data ?? assignResp.data;
        const ok     = aData?.successCount ?? projectIds.length;
        const failed = aData?.failedCount  ?? 0;
        assignLine = `projectsAssigned: ${ok}${failed ? ` (${failed} failed)` : ''} — IDs: ${projectIds.join(', ')}`;
        this.logger.info(`NB create_campaign: assigned ${ok} project(s) to campaign ${id}`);
      } catch (err) {
        assignLine = `projectsAssigned: FAILED — ${err.message} (call nb_assign_projects manually)`;
        this.logger.warn(`NB create_campaign: project assignment failed — ${err.message}`);
      }
    }

    return [
      `Campaign created successfully.`,
      `campaignId: ${id}`,
      `name: ${name}`,
      `votingStyle: ${resolvedStyle}`,
      `status: ${statusName}`,
      `start: ${resolvedStart}`,
      `end: ${resolvedEnd}`,
      `imageUrl: ${campaign?.url ?? '(none)'}`,
      `departments:\n${depts}`,
      assignLine || null,
      `votingUrl: ${votingUrl}`,
      `qrCodeUrl: ${qrCodeUrl}`,
      `auditId: ${auditId}`,
      hcsLine,
    ].filter(Boolean).join('\n');
  }
}

// ── nb_get_campaigns ──────────────────────────────────────────────────────────

class GetCampaignsTool extends BaseHederaQueryTool {
  name = 'nb_get_campaigns';
  description =
    'List all Nature Backers campaigns with full detail: status name, departments, projects, and vote counts. ' +
    'Filter by campaignStatusId: 1=Created, 2=Active, 3=Pending, 4=Rejected, 5=Approved, 6=Cancelled. ' +
    'Omit filter to return all.';
  specificInputSchema = z.object({
    campaignStatusId: z.number().int().min(1).max(6).optional()
      .describe('Filter by status. 1=Created 2=Active 3=Pending 4=Rejected 5=Approved 6=Cancelled'),
  });
  namespace = 'nature-backers-campaign';

  async executeQuery({ campaignStatusId } = {}) {
    this.logger.info(`NB get_campaigns${campaignStatusId ? ` status=${campaignStatusId}` : ''}`);
    const resp  = await axios.get(`${NB_BASE_URL}/campaign`, { timeout: 15_000 });
    let items   = resp.data?.data ?? resp.data ?? [];
    if (!Array.isArray(items)) items = [];

    if (campaignStatusId != null) {
      items = items.filter(c => c.campaignStatusId === campaignStatusId);
    }

    if (items.length === 0) {
      return campaignStatusId != null
        ? `No campaigns found with statusId=${campaignStatusId}.`
        : 'No campaigns found.';
    }

    const lines = items.map((c, i) => `${i + 1}. ──────────────────────\n${fmtCampaignSummary(c)}`);
    return `${items.length} campaign(s):\n\n${lines.join('\n\n')}`;
  }
}

// ── nb_get_campaign ───────────────────────────────────────────────────────────

class GetCampaignTool extends BaseHederaQueryTool {
  name = 'nb_get_campaign';
  description =
    'Fetch full detail for a single campaign by ID. ' +
    'Returns all fields including CampaignProject (with full project data), ' +
    'CampaignDepartment (with department names), email body/subject, url, and tx_hash.';
  specificInputSchema = z.object({
    campaignId: z.number().int().min(1).describe('Numeric campaign ID.'),
  });
  namespace = 'nature-backers-campaign';

  async executeQuery({ campaignId }) {
    this.logger.info(`NB get_campaign id=${campaignId}`);
    const resp     = await axios.get(`${NB_BASE_URL}/campaign/${campaignId}`, { timeout: 15_000 });
    const campaign = resp.data?.data ?? resp.data;
    if (!campaign) return `Campaign ${campaignId} not found.`;

    return `── Campaign ${campaignId} ──\n${fmtCampaignSummary(campaign)}`;
  }
}

// ── nb_assign_projects ────────────────────────────────────────────────────────

// ── nb_search_projects ────────────────────────────────────────────────────────

class SearchNBProjectsTool extends BaseHederaQueryTool {
  name = 'nb_search_projects';
  description =
    'PRIMARY tool for finding projects to feature in a campaign. ' +
    'Searches the NatureBackers platform database. ' +
    'PRIORITY: Guardian-indexed (on-chain verified) projects are always returned first. ' +
    'Unverified backend-only projects are only returned as a fallback when no indexed projects match. ' +
    'Returns NB integer project IDs (required by nb_assign_projects), full names, types, SDGs, location, and methodology. ' +
    'Use keyword to filter: e.g. "wetland", "coastal", "reforestation", "watershed", "bay area", "mangrove", "solar", "biochar". ' +
    'Omit keyword to list ALL available projects. ' +
    'Always call this (not sp_search_projects) when a user asks to find projects for a campaign.';
  specificInputSchema = z.object({
    keyword: z.string().optional().describe(
      'Filter keyword matched against project name, type, sector, methodology, and SDG names. ' +
      'Examples: "wetland", "coastal", "bay area", "watershed", "mangrove", "reforestation", "solar", "climate".'
    ),
    sdg: z.number().int().min(1).max(17).optional().describe(
      'Filter by SDG number. Returns only projects tagged with this SDG.'
    ),
  });
  namespace = 'nature-backers-campaign';

  async executeQuery({ keyword, sdg }) {
    this.logger.info(`NB search_projects keyword="${keyword ?? ''}" sdg=${sdg}`);
    const resp = await axios.get(`${NB_BASE_URL}/project`, { timeout: 15_000 });
    const raw = resp.data?.data ?? resp.data ?? [];
    let projects = Array.isArray(raw) ? raw : [];

    // Skip internal/workflow documents
    const SKIP_NAMES = ['Create Project Design Document (PDD)', 'Create Monitoring Report (MR)', 'Verify project', 'VVB Verification Report'];
    projects = projects.filter(p => !SKIP_NAMES.includes(p.projectName));
    const allClean = projects.slice(); // snapshot before keyword filter for broad fallback

    if (keyword) {
      const kw = keyword.toLowerCase();
      projects = projects.filter(p => {
        const sdgNames = (p.sdgs ?? []).map(s => (s.sdg?.name ?? '').toLowerCase()).join(' ');
        return (p.projectName ?? '').toLowerCase().includes(kw) ||
          (p.projectTypes ?? '').toLowerCase().includes(kw) ||
          (p.primarySector ?? '').toLowerCase().includes(kw) ||
          (p.projectMethodology ?? '').toLowerCase().includes(kw) ||
          sdgNames.includes(kw);
      });
    }

    if (sdg) {
      projects = projects.filter(p => (p.sdgs ?? []).some(s => s.sdgId === sdg));
    }

    if (projects.length === 0) {
      const hint = keyword || (sdg ? `SDG ${sdg}` : '');
      return `No NB projects found matching "${hint}". Try a broader keyword (e.g. "coastal", "restoration", "water") or omit it to list all projects.`;
    }

    // Prioritise Guardian-indexed (live) projects. If the keyword yields no live
    // projects, widen the search using broad climate keywords before falling back
    // to unverified projects — verified beats unverified regardless of keyword.
    const liveProjects      = projects.filter(p => !!p.consensusTimestamp);
    const hardcodedProjects = projects.filter(p => !p.consensusTimestamp);

    let projectsToShow;
    let fallbackNote = null;

    if (liveProjects.length > 0) {
      projectsToShow = liveProjects;
    } else {
      // No live projects for this keyword — try broader terms before showing unverified
      const BROAD_KEYWORDS = ['reforestation', 'forest', 'climate', 'biochar', 'wetland', 'coastal', 'restoration'];
      let broadLive = [];
      for (const bk of BROAD_KEYWORDS) {
        const bMatched = allClean.filter(p => {
          const sdgNames = (p.sdgs ?? []).map(s => (s.sdg?.name ?? '').toLowerCase()).join(' ');
          return (p.projectName ?? '').toLowerCase().includes(bk) ||
            (p.projectTypes ?? '').toLowerCase().includes(bk) ||
            (p.primarySector ?? '').toLowerCase().includes(bk) ||
            (p.projectMethodology ?? '').toLowerCase().includes(bk) ||
            sdgNames.includes(bk);
        });
        broadLive = bMatched.filter(p => !!p.consensusTimestamp);
        if (broadLive.length >= 2) break;
      }

      if (broadLive.length > 0) {
        projectsToShow = broadLive;
        const query = keyword ? `"${keyword}"` : sdg ? `SDG ${sdg}` : 'this query';
        fallbackNote =
          `⚠️ No Guardian-indexed projects match ${query} exactly. ` +
          `Showing ${broadLive.length} verified project(s) from the broader climate/reforestation category instead — these are on-chain verified.`;
      } else {
        projectsToShow = hardcodedProjects;
        const query = keyword ? `"${keyword}"` : sdg ? `SDG ${sdg}` : 'this query';
        fallbackNote =
          `⚠️ No Guardian-indexed (on-chain verified) projects found. ` +
          `Showing ${hardcodedProjects.length} unverified project(s) from the NatureBackers database. ` +
          `These are not yet registered on the Guardian mainnet indexer.`;
      }
    }

    const formatProject = (p) => {
      const sdgLabels = (p.sdgs ?? []).map(s => `SDG ${s.sdgId} - ${s.sdg?.name ?? ''}`).join(', ');
      const location  = [
        p.latitude  != null ? `${p.latitude.toFixed(2)}°N`  : null,
        p.longitude != null ? `${p.longitude.toFixed(2)}°E` : null,
      ].filter(Boolean).join(', ');
      const url = indexerLink(p.consensusTimestamp);
      return [
        `NB Project ID: ${p.id}  |  ${p.projectName ?? 'Unnamed'}`,
        `  Type: ${p.projectTypes ?? 'N/A'}`,
        p.primarySector      ? `  Sector:      ${p.primarySector}`       : null,
        p.projectMethodology ? `  Methodology: ${p.projectMethodology}`  : null,
        sdgLabels            ? `  SDGs:        ${sdgLabels}`             : null,
        location             ? `  Location:    ${location}`              : null,
        `  Status:      ${p.status ?? 'N/A'}`,
        url
          ? `  🔗 Indexer: [Verify on Guardian Mainnet](${url})`
          : `  🔗 Indexer: not registered on Guardian mainnet indexer`,
      ].filter(Boolean).join('\n');
    };

    const lines = projectsToShow.map(formatProject);
    const header = `NatureBackers projects${keyword ? ` matching "${keyword}"` : sdg ? ` with SDG ${sdg}` : ' (all)'}` +
      ` — ${projectsToShow.length} Guardian-indexed project(s)` +
      (liveProjects.length === 0 && hardcodedProjects.length > 0 ? ` (unverified fallback)` : '') +
      `:`;

    return [fallbackNote, `${header}\n\n${lines.join('\n\n')}`].filter(Boolean).join('\n\n');
  }
}

// ── nb_assign_projects ────────────────────────────────────────────────────────

class AssignProjectsTool extends BaseHederaQueryTool {
  name = 'nb_assign_projects';
  description =
    'Link 1–3 sustainability projects to a campaign. ' +
    'Call immediately after nb_create_campaign. Pass ALL confirmed project IDs together in one call — ' +
    'campaigns support multiple projects; voters choose one when they vote. ' +
    'Returns success/failure count and details for each project assignment.';
  specificInputSchema = z.object({
    campaignId:  z.number().int().min(1).describe('Campaign ID to assign projects to.'),
    projectIds:  z.array(z.union([z.number().int().min(1), z.string()])).min(1).max(3)
                   .describe('Array of 1–3 NB project IDs (integers). Include ALL confirmed projects.'),
  });
  namespace = 'nature-backers-campaign';

  async executeQuery({ campaignId, projectIds }) {
    const intIds = projectIds.map(id => {
      const n = typeof id === 'number' ? id : parseInt(String(id), 10);
      return isNaN(n) ? null : n;
    }).filter(Boolean);

    if (intIds.length === 0) {
      return 'Could not assign: project IDs could not be parsed as integers. Use the "NB Project ID" integer from search results.';
    }

    this.logger.info(`NB assign_projects campaignId=${campaignId} projects=${JSON.stringify(intIds)}`);
    const resp   = await axios.post(
      `${NB_BASE_URL}/campaign-project/assign`,
      { campaignId, projectIds: intIds },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15_000 }
    );
    const data   = resp.data?.data ?? resp.data;
    const ok     = data?.successCount ?? intIds.length;
    const failed = data?.failedCount  ?? 0;

    const resultLines = (data?.results ?? []).map(r => {
      if (r.success) return `  ✓ Project ${r.projectId}: ${r.data?.project?.projectName ?? 'assigned'}`;
      return `  ✗ Project ${r.projectId}: ${r.error ?? 'failed'}`;
    });

    return [
      `Assigned ${ok} project(s) to campaign ${campaignId}${failed ? ` (${failed} failed)` : ''}.`,
      ...resultLines,
    ].join('\n');
  }
}

// ── nb_get_campaign_votes ─────────────────────────────────────────────────────

class GetCampaignVotesTool extends BaseHederaQueryTool {
  name = 'nb_get_campaign_votes';
  description =
    'Retrieve all votes for a campaign from the NatureBackers database. ' +
    'Returns voter name, email, project voted for, reason, vote_hash, and timestamps. ' +
    'Requires an admin userId. Use this to see who voted for what before checking on-chain data.';
  specificInputSchema = z.object({
    campaignId: z.number().int().min(1).describe('Campaign ID.'),
    userId:     z.number().int().min(1).describe('Admin user ID required for authorization.'),
  });
  namespace = 'nature-backers-campaign';

  async executeQuery({ campaignId, userId }) {
    this.logger.info(`NB get_campaign_votes campaignId=${campaignId} userId=${userId}`);
    const resp = await axios.get(
      `${NB_BASE_URL}/vote/campaign-votes/${campaignId}`,
      { params: { userId }, timeout: 15_000 }
    );
    const data = resp.data?.data ?? resp.data;
    if (!data) return `No vote data returned for campaign ${campaignId}.`;

    const campaign   = data.campaign ?? {};
    const votes      = data.votes ?? [];
    const totalVotes = data.totalVotes ?? votes.length;

    if (votes.length === 0) {
      return `Campaign "${campaign.name}" (ID: ${campaignId}) has no votes yet.`;
    }

    const lines = votes.map((v, i) => {
      const user = v.user ?? {};
      const proj = v.project ?? {};
      const reason = v.voteData?.reason ?? '(none)';
      return [
        `  ${i + 1}. Vote ID: ${v.id}`,
        `     Voter:   ${user.first_name ?? ''} ${user.last_name ?? ''} <${user.business_email ?? '?'}>`,
        `     Project: ${proj.projectName ?? '?'} (ID: ${v.projectId})`,
        `     Reason:  ${reason}`,
        `     Hash:    ${v.vote_hash ?? '(not yet on-chain)'}`,
        `     Time:    ${v.createdAt}`,
      ].join('\n');
    });

    return [
      `Campaign: "${campaign.name}" (ID: ${campaignId})  tx_hash: ${campaign.tx_hash ?? '(none)'}`,
      `Total votes: ${totalVotes}`,
      '',
      ...lines,
    ].join('\n');
  }
}

// ── nb_get_hedera_votes ───────────────────────────────────────────────────────

class GetHederaVotesTool extends BaseHederaQueryTool {
  name = 'nb_get_hedera_votes';
  description =
    'Retrieve votes for a campaign directly from the Hedera blockchain. ' +
    'Returns decoded vote data: voter address, email, project voted, reason, department, and timestamps. ' +
    'Only available for Approved campaigns (statusId=5). Requires an admin userId.';
  specificInputSchema = z.object({
    campaignId: z.number().int().min(1).describe('Campaign ID (must be Approved, status 5).'),
    userId:     z.number().int().min(1).describe('Admin user ID required for authorization.'),
  });
  namespace = 'nature-backers-campaign';

  async executeQuery({ campaignId, userId }) {
    this.logger.info(`NB get_hedera_votes campaignId=${campaignId} userId=${userId}`);
    const resp = await axios.get(
      `${NB_BASE_URL}/vote/hedera/${campaignId}`,
      { params: { userId }, timeout: 20_000 }
    );
    const data  = resp.data?.data ?? resp.data;
    const votes = data?.votes ?? [];

    if (votes.length === 0) {
      return `No on-chain votes found for campaign ${campaignId}. Campaign may not be Approved yet.`;
    }

    const lines = votes.map((v, i) => {
      const ad = v.additionalData ?? v;
      return [
        `  ${i + 1}. Vote ID: ${ad.voteId ?? '?'}`,
        `     Voter:    ${ad.userName ?? '?'} (user ID ${ad.userId ?? '?'})  email: ${v.email ?? '?'}`,
        `     Address:  ${v.voterAddress ?? '?'}`,
        `     Project:  ${ad.projectName ?? '?'} (ID: ${ad.projectId ?? '?'})`,
        `     Dept:     ${ad.departmentId ?? '?'}`,
        `     Reason:   ${ad.reason ?? '(none)'}`,
        `     Option:   ${v.voteOption ?? '?'}`,
        `     Time:     ${ad.createdAt ?? '?'}`,
      ].join('\n');
    });

    return [
      `On-chain votes for campaign ${campaignId} — ${votes.length} vote(s) from Hedera:`,
      '',
      ...lines,
    ].join('\n');
  }
}

// ── nb_get_vote_proof ─────────────────────────────────────────────────────────

class GetVoteProofTool extends BaseHederaQueryTool {
  name = 'nb_get_vote_proof';
  description =
    'Generate a Merkle proof for vote integrity verification for a campaign. ' +
    'Returns the Merkle root, all vote hashes, inclusion proofs, and full vote details. ' +
    'Use to verify that specific votes are included in the on-chain Merkle tree. ' +
    'Requires an admin userId.';
  specificInputSchema = z.object({
    campaignId: z.number().int().min(1).describe('Campaign ID.'),
    userId:     z.number().int().min(1).describe('Admin user ID required for authorization.'),
    voteIds:    z.array(z.number().int()).optional()
                  .describe('Specific vote IDs to prove. Omit to include all votes.'),
  });
  namespace = 'nature-backers-campaign';

  async executeQuery({ campaignId, userId, voteIds }) {
    this.logger.info(`NB get_vote_proof campaignId=${campaignId} userId=${userId}`);
    const params = { userId };
    if (voteIds && voteIds.length > 0) params.voteIds = voteIds.join(',');

    const resp = await axios.get(
      `${NB_BASE_URL}/vote/proof/${campaignId}`,
      { params, timeout: 20_000 }
    );
    const data = resp.data?.data ?? resp.data;
    if (!data) return `No proof data returned for campaign ${campaignId}.`;

    const voteLines = (data.votes ?? []).map((v, i) =>
      `  ${i + 1}. Vote ID ${v.id}  user: ${v.userName} <${v.userEmail}>  project: ${v.projectName}  hash: ${v.voteHash?.slice(0, 20)}…`
    );

    return [
      `Vote Merkle Proof — Campaign ${campaignId} "${data.campaignName}"`,
      `Merkle Root:  ${data.merkleRoot}`,
      `Total Votes:  ${data.totalVotes}`,
      `Generated:    ${data.timestamp}`,
      '',
      `Votes included:`,
      ...voteLines,
    ].join('\n');
  }
}

// ── nb_push_votes_to_hedera ───────────────────────────────────────────────────

class PushVotesToHederaTool extends BaseHederaQueryTool {
  name = 'nb_push_votes_to_hedera';
  description =
    'Push all votes for an Approved campaign to the Hedera blockchain. ' +
    'Generates a Merkle tree of all votes and records the root on-chain. ' +
    'Only works when campaign status is Approved (statusId=5). ' +
    'Returns push count, any failures, and the resulting tx_hash stored on the campaign.';
  specificInputSchema = z.object({
    campaignId: z.number().int().min(1).describe('Campaign ID (must have status Approved = 5).'),
  });
  namespace = 'nature-backers-campaign';

  async executeQuery({ campaignId }) {
    this.logger.info(`NB push_votes_to_hedera campaignId=${campaignId}`);
    const resp = await axios.post(
      `${NB_BASE_URL}/vote/hedera/${campaignId}`,
      {},
      { headers: { 'Content-Type': 'application/json' }, timeout: 30_000 }
    );
    const data = resp.data?.data ?? resp.data;

    const pushed   = data?.pushedCount  ?? '?';
    const failed   = data?.failedCount  ?? 0;
    const merkle   = data?.merkleGenerated ? `yes  root: ${data.merkleRoot ?? '?'}` : 'no';
    const txHash   = data?.existingTxHash ?? '(see campaign tx_hash)';
    const skipped  = data?.skipped ? ' (already pushed — skipped)' : '';

    return [
      `Push votes to Hedera${skipped}`,
      `Campaign ID:      ${campaignId}`,
      `Pushed:           ${pushed}`,
      failed ? `Failed:           ${failed}  ids: ${(data?.failedVotes ?? []).join(', ')}` : null,
      `Merkle generated: ${merkle}`,
      `tx_hash:          ${txHash}`,
      data?.message ? `Message: ${data.message}` : null,
    ].filter(Boolean).join('\n');
  }
}

// ── nb_record_campaign_report ─────────────────────────────────────────────────

class RecordCampaignReportTool extends BaseHederaQueryTool {
  name = 'nb_record_campaign_report';
  description =
    'Compile the final campaign results report and record it immutably on Hedera HCS. ' +
    'ONLY call this after the campaign is Approved (statusId=5) and votes have been pushed to Hedera ' +
    'via nb_push_votes_to_hedera. Fetches the on-chain Hedera votes (with vote hashes) and the ' +
    'Merkle proof, then records the full report — including Merkle root and per-vote hashes — on HCS.';
  specificInputSchema = z.object({
    campaignId: z.number().int().min(1).describe('Campaign ID (must be Approved, status 5, with votes on Hedera).'),
    userId:     z.number().int().min(1).optional().describe('Admin user ID for vote retrieval. Optional — omit if unknown.'),
    note:       z.string().optional().describe('Optional note to include in the report.'),
  });
  namespace = 'nature-backers-campaign';

  async executeQuery({ campaignId, userId, note }) {
    this.logger.info(`NB record_campaign_report campaignId=${campaignId} userId=${userId ?? 'none'}`);

    // Fetch campaign first (needed for status check + vote fallback)
    const campResp = await axios.get(`${NB_BASE_URL}/campaign/${campaignId}`, { timeout: 15_000 });
    const campaign = campResp.data?.data ?? campResp.data;

    // Enforce Approved status before writing the HCS report
    const statusId = campaign?.campaignStatusId;
    if (statusId !== 5) {
      const statusName = campaign?.campaignStatus?.name ?? `statusId ${statusId ?? '?'}`;
      return [
        `Cannot generate HCS final report: campaign ${campaignId} is not Approved.`,
        `Current status: ${statusName}`,
        ``,
        `Required flow:`,
        `  1. Campaign ends (status → Pending)`,
        `  2. Admin approves (status → Approved)`,
        `  3. Call nb_push_votes_to_hedera to push votes on-chain`,
        `  4. Then call nb_record_campaign_report`,
      ].join('\n');
    }

    // Fetch votes with fallback logic (userId fallback + campaign.votes fallback)
    const { dbVotes, hederaVotes, merkleRoot, merkleVotes } =
      await fetchVotesForCampaign(campaignId, userId, campaign);

    this.logger.info(`NB record_campaign_report votes: db=${dbVotes.length} hedera=${hederaVotes.length} merkle=${merkleVotes.length}`);

    // Use DB votes as primary tally — fall back to Hedera votes if DB returned nothing
    const votesForTally = dbVotes.length > 0 ? dbVotes : hederaVotes;

    // Tally votes per project
    const projectTally = {};
    for (const v of votesForTally) {
      // DB vote shape: { projectId, project: { projectName } }
      // Hedera vote shape: { additionalData: { projectId, projectName } }
      const projectId   = v.projectId ?? v.additionalData?.projectId ?? '?';
      const projectName = v.project?.projectName ?? v.additionalData?.projectName ?? 'Unknown';
      const key = `${projectId}:${projectName}`;
      projectTally[key] = (projectTally[key] ?? 0) + 1;
    }

    const topProject = Object.entries(projectTally).sort((a, b) => b[1] - a[1])[0];

    // Build per-vote hash list — merge DB vote_hash with Merkle proof hashes
    const dbHashMap = Object.fromEntries(dbVotes.map(v => [v.id, v.vote_hash]));
    const voteHashes = merkleVotes.length > 0
      ? merkleVotes.map(v => ({
          voteId:      v.id,
          voterEmail:  v.userEmail,
          projectName: v.projectName,
          voteHash:    v.voteHash ?? dbHashMap[v.id],
        }))
      : dbVotes.map(v => ({
          voteId:      v.id,
          voterEmail:  v.user?.business_email ?? '?',
          projectName: v.project?.projectName ?? '?',
          voteHash:    v.vote_hash,
        }));

    const report = {
      reportType:    'CAMPAIGN_FINAL_REPORT',
      campaignId,
      campaignName:  campaign?.name ?? 'Unknown',
      status:        campaign?.campaignStatus?.name ?? 'Approved',
      startDate:     campaign?.startDate ?? null,
      endDate:       campaign?.endDate   ?? null,
      hederaTxHash:  campaign?.tx_hash   ?? null,
      totalVotes:    votesForTally.length,
      merkleRoot,
      voteHashes,
      projectTally,
      winningProject: topProject
        ? { id: topProject[0].split(':')[0], name: topProject[0].split(':').slice(1).join(':'), votes: topProject[1] }
        : null,
      projects: (campaign?.CampaignProject ?? []).map(cp => ({
        projectId:   cp.projectId,
        projectName: cp.project?.projectName ?? 'Unknown',
        votes:       projectTally[`${cp.projectId}:${cp.project?.projectName ?? 'Unknown'}`] ?? 0,
      })),
      generatedAt: new Date().toISOString(),
      note:        note ?? null,
    };

    const result = await recordCrossChainAudit({
      eventType: 'CAMPAIGN_FINAL_REPORT',
      entityId:  `campaign-${campaignId}`,
      actor:     `admin-${userId ?? 'agent'}`,
      payload:   report,
      tags:      [`campaign-${campaignId}`, 'final-report'],
    });

    const { auditId, hcs, summary } = result;

    return [
      `Campaign Final Report — Recorded on HCS`,
      ``,
      `Campaign:        ${report.campaignName} (ID: ${campaignId})`,
      `Status:          ${report.status}`,
      `Period:          ${report.startDate} → ${report.endDate}`,
      `Hedera tx_hash:  ${report.hederaTxHash ?? '(none)'}`,
      ``,
      `Total Votes:     ${report.totalVotes}`,
      report.winningProject
        ? `Winning Project: ${report.winningProject.name} — ${report.winningProject.votes} vote(s)`
        : `Winning Project: (no votes)`,
      ``,
      `Vote Breakdown:`,
      ...report.projects.map(p => `  - ${p.projectName}: ${p.votes} vote(s)`),
      ``,
      `Merkle Root:     ${merkleRoot ?? '(not available)'}`,
      voteHashes.length > 0
        ? `Vote Hashes:\n${voteHashes.map(v => `  - vote ${v.voteId} (${v.projectName}): ${v.voteHash}`).join('\n')}`
        : `Vote Hashes:     (none)`,
      ``,
      `HCS Audit ID:    ${auditId}`,
      `HCS Status:      ${summary.status}`,
      hcs.error ? `HCS Error:       ${hcs.error}` : `HCS tx_hash:     ${hcs.tx_hash}${hcs.simulated ? ' (simulated)' : ''}`,
      `Recorded at:     ${summary.timestamp}`,
    ].join('\n');
  }
}

// ── nb_get_campaign_hcs_report ────────────────────────────────────────────────

class GetCampaignHcsReportTool extends BaseHederaQueryTool {
  name = 'nb_get_campaign_hcs_report';
  description =
    'Retrieve the HCS-recorded final report for a campaign. ' +
    'Checks in-memory log, then queries the Hedera mirror node. ' +
    'If no report exists yet but the campaign is Approved (status 5), automatically generates and records it. ' +
    'No need to call nb_record_campaign_report separately — this tool handles the full flow.';
  specificInputSchema = z.object({
    campaignId: z.number().int().min(1).describe('Campaign ID to retrieve (or auto-generate) the HCS final report for.'),
    userId:     z.number().int().min(1).optional().describe('Admin user ID for vote data retrieval. Optional.'),
  });
  namespace = 'nature-backers-campaign';

  async executeQuery({ campaignId, userId }) {
    this.logger.info(`NB get_campaign_hcs_report campaignId=${campaignId}`);

    // ── 1. Check in-memory log ────────────────────────────────────────────────
    const entries = getAuditLogs({
      eventType: 'CAMPAIGN_FINAL_REPORT',
      entityId:  `campaign-${campaignId}`,
    });

    if (entries.length > 0) {
      return this.#formatEntries(entries, campaignId);
    }

    // ── 2. Check Hedera mirror node ───────────────────────────────────────────
    const topicId = process.env.AUDIT_HCS_TOPIC_ID || process.env.AUDIT_TOPIC_ID;
    if (topicId) {
      try {
        const mirrorResp = await axios.get(
          `${mirrorNodeBase()}/api/v1/topics/${topicId}/messages`,
          { params: { limit: 100 }, timeout: 15_000 }
        );
        const msgs = mirrorResp.data?.messages ?? [];
        const matching = msgs.filter(m => {
          try {
            const parsed = JSON.parse(Buffer.from(m.message, 'base64').toString('utf8'));
            return parsed?.payload?.campaignId === campaignId &&
                   parsed?.eventType === 'CAMPAIGN_FINAL_REPORT';
          } catch { return false; }
        });

        if (matching.length > 0) {
          const lines = matching.map((m, i) => {
            const parsed = JSON.parse(Buffer.from(m.message, 'base64').toString('utf8'));
            const p = parsed.payload ?? {};
            return [
              `Report ${i + 1}: seq#${m.sequence_number}  ts=${m.consensus_timestamp}`,
              `  Campaign:    ${p.campaignName}  Status: ${p.status}`,
              `  Total Votes: ${p.totalVotes}`,
              p.merkleRoot ? `  Merkle Root: ${p.merkleRoot}` : null,
              p.winningProject ? `  Winner:      ${p.winningProject.name} (${p.winningProject.votes} votes)` : null,
              p.voteHashes?.length
                ? `  Vote Hashes:\n${p.voteHashes.map(v => `    - vote ${v.voteId} (${v.projectName}): ${v.voteHash}`).join('\n')}`
                : null,
              p.note ? `  Note: ${p.note}` : null,
            ].filter(Boolean).join('\n');
          });
          return [
            `HCS Final Report for campaign ${campaignId} — found ${matching.length} record(s) on topic ${topicId}:`,
            '',
            ...lines,
          ].join('\n');
        }
      } catch (err) {
        this.logger.warn(`HCS mirror query failed: ${err.message}`);
      }
    }

    // ── 3. No report exists — check if campaign is Approved and auto-generate ─
    this.logger.info(`NB get_campaign_hcs_report: no report found, checking campaign status`);
    let campaign;
    try {
      const campResp = await axios.get(`${NB_BASE_URL}/campaign/${campaignId}`, { timeout: 15_000 });
      campaign = campResp.data?.data ?? campResp.data;
    } catch (err) {
      return `No HCS final report found for campaign ${campaignId} and could not fetch campaign status: ${err.message}`;
    }

    const statusId = campaign?.campaignStatusId;
    if (statusId !== 5) {
      const statusName = campaign?.campaignStatus?.name ?? `statusId ${statusId ?? '?'}`;
      return [
        `No HCS final report for campaign ${campaignId}.`,
        `Campaign status: ${statusName} — report can only be generated after Approval (status 5).`,
      ].join('\n');
    }

    // Campaign is Approved — auto-generate the HCS final report
    this.logger.info(`NB get_campaign_hcs_report: campaign ${campaignId} is Approved — auto-generating HCS report`);

    const { dbVotes, hederaVotes, merkleRoot, merkleVotes } =
      await fetchVotesForCampaign(campaignId, userId, campaign);

    this.logger.info(`NB get_campaign_hcs_report votes: db=${dbVotes.length} hedera=${hederaVotes.length} merkle=${merkleVotes.length}`);

    const votesForTally = dbVotes.length > 0 ? dbVotes : hederaVotes;

    const projectTally = {};
    for (const v of votesForTally) {
      const projectId   = v.projectId ?? v.additionalData?.projectId ?? '?';
      const projectName = v.project?.projectName ?? v.additionalData?.projectName ?? 'Unknown';
      const key = `${projectId}:${projectName}`;
      projectTally[key] = (projectTally[key] ?? 0) + 1;
    }
    const topProject = Object.entries(projectTally).sort((a, b) => b[1] - a[1])[0];

    const dbHashMap = Object.fromEntries(dbVotes.map(v => [v.id, v.vote_hash]));
    const voteHashes = merkleVotes.length > 0
      ? merkleVotes.map(v => ({ voteId: v.id, voterEmail: v.userEmail, projectName: v.projectName, voteHash: v.voteHash ?? dbHashMap[v.id] }))
      : dbVotes.map(v => ({ voteId: v.id, voterEmail: v.user?.business_email ?? '?', projectName: v.project?.projectName ?? '?', voteHash: v.vote_hash }));

    const report = {
      reportType:    'CAMPAIGN_FINAL_REPORT',
      campaignId,
      campaignName:  campaign.name,
      status:        campaign.campaignStatus?.name ?? 'Approved',
      startDate:     campaign.startDate ?? null,
      endDate:       campaign.endDate   ?? null,
      hederaTxHash:  campaign.tx_hash   ?? null,
      totalVotes:    votesForTally.length,
      merkleRoot,
      voteHashes,
      projectTally,
      winningProject: topProject
        ? { id: topProject[0].split(':')[0], name: topProject[0].split(':').slice(1).join(':'), votes: topProject[1] }
        : null,
      projects: (campaign.CampaignProject ?? []).map(cp => ({
        projectId:   cp.projectId,
        projectName: cp.project?.projectName ?? 'Unknown',
        votes:       projectTally[`${cp.projectId}:${cp.project?.projectName ?? 'Unknown'}`] ?? 0,
      })),
      generatedAt: new Date().toISOString(),
      note:        null,
    };

    const result = await recordCrossChainAudit({
      eventType: 'CAMPAIGN_FINAL_REPORT',
      entityId:  `campaign-${campaignId}`,
      actor:     userId != null ? `admin-${userId}` : 'agent',
      payload:   report,
      tags:      [`campaign-${campaignId}`, 'final-report'],
    });

    const { auditId, hcs, summary } = result;

    return [
      `HCS Final Report — Auto-generated and recorded for campaign ${campaignId}`,
      ``,
      `Campaign:        ${report.campaignName}`,
      `Status:          ${report.status}`,
      `Period:          ${report.startDate} → ${report.endDate}`,
      `Hedera tx_hash:  ${report.hederaTxHash ?? '(none)'}`,
      ``,
      `Total Votes:     ${report.totalVotes}`,
      report.winningProject
        ? `Winning Project: ${report.winningProject.name} — ${report.winningProject.votes} vote(s)`
        : `Winning Project: (no votes)`,
      ``,
      `Vote Breakdown:`,
      ...report.projects.map(p => `  - ${p.projectName}: ${p.votes} vote(s)`),
      ``,
      `Merkle Root:     ${merkleRoot ?? '(not available)'}`,
      voteHashes.length > 0
        ? `Vote Hashes:\n${voteHashes.map(v => `  - vote ${v.voteId} (${v.projectName}): ${v.voteHash}`).join('\n')}`
        : `Vote Hashes:     (none)`,
      ``,
      `HCS Audit ID:    ${auditId}`,
      `HCS Status:      ${summary.status}`,
      hcs.error ? `HCS Error:       ${hcs.error}` : `HCS tx_hash:     ${hcs.tx_hash}${hcs.simulated ? ' (simulated)' : ''}`,
      `Recorded at:     ${summary.timestamp}`,
    ].join('\n');
  }

  #formatEntries(entries, campaignId) {
    const lines = entries.map((e, i) => {
      const p = e.payload ?? {};
      const hcsLine = e.hcs?.error
        ? `  HCS: FAILED — ${e.hcs.error}`
        : `  HCS: ${e.hcs?.tx_hash ?? '?'}${e.hcs?.simulated ? ' (simulated)' : ''}`;
      return [
        `Report ${i + 1} — Audit ID: ${e.auditId}`,
        `  Campaign:    ${p.campaignName ?? campaignId}  Status: ${p.status ?? '?'}`,
        `  Total Votes: ${p.totalVotes ?? '?'}`,
        p.merkleRoot ? `  Merkle Root: ${p.merkleRoot}` : null,
        p.winningProject ? `  Winner: ${p.winningProject.name} (${p.winningProject.votes} votes)` : null,
        `  Vote Breakdown: ${Object.entries(p.projectTally ?? {}).map(([k, v]) => `${k.split(':').slice(1).join(':')} (${v})`).join(', ')}`,
        p.voteHashes?.length
          ? `  Vote Hashes:\n${p.voteHashes.map(v => `    - vote ${v.voteId} (${v.projectName}): ${v.voteHash}`).join('\n')}`
          : null,
        `  Recorded at: ${e.timestamp}`,
        hcsLine,
      ].filter(Boolean).join('\n');
    });
    return [
      `HCS Final Report(s) for campaign ${campaignId} — ${entries.length} found:`,
      '',
      ...lines,
    ].join('\n');
  }
}

// ── nb_get_votes_by_campaign (legacy — full chain decode) ─────────────────────

class GetVotesByCampaignTool extends BaseHederaQueryTool {
  name = 'nb_get_votes_by_campaign';
  description =
    'Fetch a campaign by ID, then decode the on-chain vote from the Hedera mirror node using its tx_hash. ' +
    'Returns full campaign detail PLUS decoded ABI vote parameters (voter, project, reason). ' +
    'For a simple vote list use nb_get_campaign_votes; for raw Hedera chain data use nb_get_hedera_votes.';
  specificInputSchema = z.object({
    campaignId: z.number().int().min(1).describe('Campaign ID to retrieve and decode.'),
  });
  namespace = 'nature-backers-campaign';

  async executeQuery({ campaignId }) {
    this.logger.info(`NB get_votes_by_campaign campaignId=${campaignId}`);

    const campResp = await axios.get(`${NB_BASE_URL}/campaign/${campaignId}`, { timeout: 15_000 });
    const campaign = campResp.data?.data ?? campResp.data;
    if (!campaign) return `Campaign ${campaignId} not found.`;

    const campaignDetail = `── Campaign Detail ──\n${fmtCampaignSummary(campaign)}`;
    const txHash = campaign.tx_hash;

    if (!txHash) {
      return `${campaignDetail}\n\nNo on-chain tx_hash recorded yet for this campaign.`;
    }

    let contractResult;
    try {
      const mirrorResp = await axios.get(
        `${mirrorNodeBase()}/api/v1/contracts/results/${txHash}`,
        { timeout: 15_000 }
      );
      contractResult = mirrorResp.data;
    } catch (err) {
      return `${campaignDetail}\n\nHedera mirror node lookup failed: ${err.message}`;
    }

    const decoded = decodeVoteParams(contractResult.function_parameters);
    const vote    = decoded?.vote;

    const chainLines = [
      '',
      `── Hedera On-Chain Record ──`,
      `Transaction hash: ${txHash}`,
      `Contract (Hedera): ${contractResult.contract_id}`,
      `Block:             ${contractResult.block_number}`,
      `Consensus time:    ${contractResult.timestamp}`,
      `Status:            ${contractResult.result}`,
      `Gas used:          ${contractResult.gas_used?.toLocaleString()} / ${contractResult.gas_limit?.toLocaleString()}`,
    ];

    if (vote) {
      chainLines.push('', `── Decoded Vote ──`);
      chainLines.push(`Vote ID:       ${vote.voteId}`);
      chainLines.push(`Voter:         ${vote.userName} (user ID ${vote.userId})`);
      if (decoded.voterEmail) chainLines.push(`Voter email:   ${decoded.voterEmail}`);
      chainLines.push(`Project voted: ${vote.projectName} (project ID ${vote.projectId})`);
      chainLines.push(`Department:    ${decoded.departmentId}`);
      chainLines.push(`Reason:        ${vote.reason || '(none)'}`);
      chainLines.push(`Recorded at:   ${vote.createdAt}`);
    } else if (contractResult.function_parameters) {
      chainLines.push('', '(Vote payload present but could not be ABI-decoded)');
    }

    return [campaignDetail, ...chainLines].join('\n');
  }
}

// ── nb_get_hcs_records ────────────────────────────────────────────────────────

class GetHcsRecordsTool extends BaseHederaQueryTool {
  name = 'nb_get_hcs_records';
  description =
    'Retrieve ALL HCS audit records for a campaign: campaign creation, final report, AND donation ' +
    'payments (HBAR intent + CLPR). Merges Hedera mirror node records with the in-memory audit log ' +
    'so nothing is missed even if HCS propagation is delayed. Use this when the user asks for ' +
    '"HCS logs", "full audit trail", or any on-chain record query for a campaign.';
  specificInputSchema = z.object({
    campaignId: z.number().int().min(1).optional()
      .describe('Filter to a specific campaign ID. Omit to return ALL HCS records across all campaigns.'),
    limit: z.number().int().min(1).max(100).optional()
      .describe('Max messages to fetch from the mirror node (default 100).'),
  });
  namespace = 'nature-backers-campaign';

  async executeQuery({ campaignId, limit = 100 }) {
    const topicId = process.env.AUDIT_HCS_TOPIC_ID || process.env.AUDIT_TOPIC_ID;
    this.logger.info(`NB get_hcs_records${topicId ? ` topic=${topicId}` : ' (no topic)'} campaignId=${campaignId ?? 'all'}`);

    // ── In-memory records ─────────────────────────────────────────────────────
    const allMem = getAuditLogs({});
    const memEntries = campaignId != null
      ? allMem.filter(e =>
          e.entityId === `campaign-${campaignId}` ||
          (e.tags ?? []).includes(`campaign-${campaignId}`)
        )
      : allMem;

    // ── Mirror node records ───────────────────────────────────────────────────
    let mirrorRecords = [];
    if (topicId) {
      try {
        const mirrorResp = await axios.get(
          `${mirrorNodeBase()}/api/v1/topics/${topicId}/messages`,
          { params: { limit }, timeout: 20_000 }
        );
        const msgs = mirrorResp.data?.messages ?? [];
        const decoded = msgs.map(m => {
          let parsed = null;
          try { parsed = JSON.parse(Buffer.from(m.message, 'base64').toString('utf8')); } catch {}
          return { raw: m, parsed };
        });

        mirrorRecords = campaignId != null
          ? decoded.filter(({ parsed }) => {
              if (!parsed) return false;
              return parsed.entityId === `campaign-${campaignId}` ||
                     parsed.payload?.campaignId === campaignId ||
                     (parsed.tags ?? []).includes(`campaign-${campaignId}`);
            })
          : decoded.filter(({ parsed }) => !!parsed);
      } catch (err) {
        this.logger.warn(`HCS mirror query failed: ${err.message}`);
      }
    }

    // ── Deduplicate: mirror wins, in-memory fills gaps ────────────────────────
    const mirrorAuditIds = new Set(mirrorRecords.map(r => r.parsed?.auditId).filter(Boolean));
    const memOnlyEntries = memEntries.filter(e => !mirrorAuditIds.has(e.auditId));

    if (mirrorRecords.length === 0 && memOnlyEntries.length === 0) {
      const noTopicHint = topicId ? '' : ' (AUDIT_HCS_TOPIC_ID not configured — only in-memory checked)';
      return `No HCS records found${campaignId != null ? ` for campaign ${campaignId}` : ''}${noTopicHint}.`;
    }

    const lines = [];
    let n = 1;

    for (const { raw, parsed } of mirrorRecords) {
      if (!parsed) {
        lines.push(`${n++}. seq#${raw.sequence_number}  ts=${raw.consensus_timestamp}\n   (could not decode message)`);
        continue;
      }
      lines.push(this.#fmt(n++, parsed, raw.sequence_number, raw.consensus_timestamp, false));
    }

    for (const e of memOnlyEntries) {
      const pseudo = { eventType: e.eventType, entityId: e.entityId, actor: e.actor, auditId: e.auditId, payload: e.payload ?? {} };
      lines.push(this.#fmt(n++, pseudo, null, e.timestamp, true));
    }

    const total = mirrorRecords.length + memOnlyEntries.length;
    const sourceNote = topicId
      ? ` (${mirrorRecords.length} on-chain, ${memOnlyEntries.length} in-memory)`
      : ' (in-memory only — AUDIT_HCS_TOPIC_ID not configured)';

    return [
      `HCS records${campaignId != null ? ` for campaign ${campaignId}` : ' (all)'}` +
        ` — ${total} record(s)${sourceNote}:`,
      '',
      ...lines,
    ].join('\n');
  }

  #fmt(num, parsed, seqNum, ts, isMemOnly) {
    const eventType = parsed.eventType ?? '?';
    const p = parsed.payload ?? {};
    const memTag = isMemOnly ? ' ⚡in-memory' : '';

    const header = `${num}. [${eventType}]${memTag}  ${seqNum != null ? `seq#${seqNum}  ` : ''}ts=${ts ?? '?'}`;
    const detail = [];
    detail.push(`   Entity:     ${parsed.entityId ?? '?'}`);
    detail.push(`   Audit ID:   ${parsed.auditId ?? '?'}`);
    detail.push(`   Actor:      ${parsed.actor ?? '?'}`);

    if (eventType === 'CAMPAIGN_CREATED') {
      if (p.name)        detail.push(`   Name:       ${p.name}`);
      if (p.votingStyle) detail.push(`   Voting:     ${p.votingStyle}`);
      if (p.startDate)   detail.push(`   Start→End:  ${p.startDate} → ${p.endDate ?? '?'}`);
      if (p.votingUrl)   detail.push(`   URL:        ${p.votingUrl}`);
    } else if (eventType === 'CAMPAIGN_FINAL_REPORT') {
      if (p.campaignName) detail.push(`   Campaign:   ${p.campaignName}  Status: ${p.status ?? '?'}`);
      detail.push(`   Votes:      ${p.totalVotes ?? '?'}`);
      if (p.winningProject) detail.push(`   Winner:     ${p.winningProject.name} (${p.winningProject.votes} vote(s))`);
      if (p.merkleRoot)     detail.push(`   Merkle:     ${p.merkleRoot}`);
      if (p.voteHashes?.count != null) detail.push(`   Vote hashes: ${p.voteHashes.count} (compacted on-chain — full hashes in memory)`);
      if (p.note)           detail.push(`   Note:       ${p.note}`);
    } else if (eventType === 'DONATION_HBAR_INTENT') {
      detail.push(`   Amount:     ${p.amount ?? '?'} HBAR (pending HashPack signature)`);
      detail.push(`   Recipient:  ${p.toAccount ?? p.hbarAddress ?? '?'}`);
      if (p.memo) detail.push(`   Memo:       ${p.memo}`);
    } else if (eventType === 'DONATION_HBAR') {
      detail.push(`   Amount:     ${p.amount ?? '?'} HBAR`);
      detail.push(`   Recipient:  ${p.toAccount ?? p.hbarAddress ?? '?'}`);
      if (p.txHash) detail.push(`   Tx Hash:    ${p.txHash}`);
    } else if (eventType === 'DONATION_CLPR') {
      detail.push(`   Amount:     ${p.amount ?? '?'} ${p.currency ?? 'CLPR'}`);
      detail.push(`   Address:    ${p.clprAddress ?? '?'}`);
      if (p.clprTxHash)   detail.push(`   CLPR Hash:  ${p.clprTxHash}`);
      if (p.clprProofHash) detail.push(`   Proof:      ${String(p.clprProofHash).slice(0, 24)}…`);
      if (p.simulated)    detail.push(`   Mode:       simulated`);
    } else {
      const summary = JSON.stringify(p).slice(0, 150);
      detail.push(`   Payload:    ${summary}${summary.length >= 150 ? '…' : ''}`);
    }

    return [header, ...detail].join('\n');
  }
}

// ── Shared PDF helpers (used by GenerateHcsPdfTool + on-demand server route) ──

function pdfSection(doc, title) {
  doc.fontSize(14).font('Helvetica-Bold').text(title).moveDown(0.3);
}
function pdfField(doc, label, value) {
  doc.fontSize(10).font('Helvetica-Bold')
    .text(`${label}: `, { continued: true })
    .font('Helvetica').text(String(value ?? ''), { lineBreak: true, width: 450 });
}
function pdfDivider(doc) {
  doc.moveDown(0.5)
    .moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').stroke()
    .strokeColor('#000000').moveDown(0.5);
}

// Renders the full PDF content into an already-open PDFDocument.
// Caller is responsible for doc.end() and piping/streaming.
export function renderHcsPdfContent(doc, records, campaignId) {
  const topicId = process.env.AUDIT_HCS_TOPIC_ID || process.env.AUDIT_TOPIC_ID;

  doc.fontSize(20).font('Helvetica-Bold')
    .text('CarbonSustain HCS Audit Report', { align: 'center' });
  doc.fontSize(13).font('Helvetica')
    .text(`Campaign ID: ${campaignId}`, { align: 'center' });
  if (topicId) {
    doc.fontSize(9).fillColor('#555555').text(`HCS Topic: ${topicId}`, { align: 'center' });
    doc.fillColor('#000000');
  }
  doc.fontSize(9).fillColor('#555555')
    .text(`Generated: ${new Date().toISOString()}`, { align: 'center' });
  doc.fillColor('#000000').moveDown();
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke().moveDown();

  if (records.length === 0) {
    doc.fontSize(12).text('No HCS records found for this campaign.', { align: 'center' });
  } else {
    const DONATION_TYPES = ['DONATION_HBAR_INTENT', 'DONATION_HBAR', 'DONATION_USDC_INTENT', 'DONATION_CLPR'];
    const CORE_TYPES    = ['CAMPAIGN_CREATED', 'CAMPAIGN_FINAL_REPORT', ...DONATION_TYPES];
    const creation    = records.find(r => r.eventType === 'CAMPAIGN_CREATED');
    const finalReport = records.find(r => r.eventType === 'CAMPAIGN_FINAL_REPORT');
    const donations   = records.filter(r => DONATION_TYPES.includes(r.eventType));
    const other       = records.filter(r => !CORE_TYPES.includes(r.eventType));

    if (creation) {
      pdfSection(doc, 'Campaign Creation');
      const p = creation.payload;
      pdfField(doc, 'Campaign Name', p.name         ?? '—');
      pdfField(doc, 'Voting Style',  p.votingStyle  ?? '—');
      pdfField(doc, 'Start Date',    p.startDate    ?? '—');
      pdfField(doc, 'End Date',      p.endDate      ?? '—');
      pdfField(doc, 'Voting URL',    p.votingUrl    ?? '—');
      pdfField(doc, 'Actor',         creation.actor ?? '—');
      pdfField(doc, 'Audit ID',      creation.auditId ?? '—');
      pdfField(doc, 'Recorded At',   creation.timestamp ?? '—');
      if (creation.hcsSeq != null) pdfField(doc, 'HCS Seq#', String(creation.hcsSeq));
      pdfDivider(doc);
    }

    if (finalReport) {
      pdfSection(doc, 'Campaign Final Report');
      const p = finalReport.payload;
      pdfField(doc, 'Campaign',    `${p.campaignName ?? '—'} (ID: ${p.campaignId ?? campaignId})`);
      pdfField(doc, 'Status',      p.status ?? '—');
      pdfField(doc, 'Period',      `${p.startDate ?? '—'} → ${p.endDate ?? '—'}`);
      pdfField(doc, 'Total Votes', String(p.totalVotes ?? 0));
      if (p.winningProject) pdfField(doc, 'Winning Project', `${p.winningProject.name} (${p.winningProject.votes} vote(s))`);
      if (p.merkleRoot)     pdfField(doc, 'Merkle Root', p.merkleRoot);
      if (p.hederaTxHash)   pdfField(doc, 'Hedera Tx Hash', p.hederaTxHash);
      if (Array.isArray(p.projects) && p.projects.length > 0) {
        doc.moveDown(0.3).fontSize(11).font('Helvetica-Bold').text('Vote Breakdown:');
        doc.font('Helvetica').fontSize(10);
        for (const proj of p.projects) doc.text(`  • ${proj.projectName ?? proj.projectId}: ${proj.votes} vote(s)`);
      }
      if (Array.isArray(p.voteHashes) && p.voteHashes.length > 0) {
        doc.moveDown(0.3).fontSize(11).font('Helvetica-Bold').text('Vote Hashes (Merkle Leaves):');
        doc.font('Helvetica').fontSize(8);
        for (const v of p.voteHashes) {
          doc.text(`  Vote ${v.voteId} (${v.projectName}): ${v.voteHash ?? '(pending)'}`, { lineBreak: true, width: 450 });
        }
        doc.fontSize(10);
      } else if (p.voteHashes?.count) {
        doc.moveDown(0.3).fontSize(10).font('Helvetica')
          .text(`Vote hashes: ${p.voteHashes.count} (stored compactly on-chain — verify via Merkle Root above)`);
      }
      pdfField(doc, 'Audit ID',    finalReport.auditId ?? '—');
      pdfField(doc, 'Recorded At', finalReport.timestamp ?? '—');
      if (finalReport.hcsSeq != null) pdfField(doc, 'HCS Seq#', String(finalReport.hcsSeq));
      pdfDivider(doc);
    }

    if (donations.length > 0) {
      pdfSection(doc, `Donation Records (${donations.length})`);
      for (let i = 0; i < donations.length; i++) {
        const d = donations[i]; const p = d.payload;
        doc.fontSize(11).font('Helvetica-Bold').text(`${i + 1}. ${d.eventType}`);
        doc.font('Helvetica').fontSize(10);
        if (d.eventType === 'DONATION_HBAR_INTENT') {
          pdfField(doc, 'Amount',    `${p.amount ?? '?'} HBAR (pending HashPack signature)`);
          pdfField(doc, 'Recipient', p.toAccount ?? p.hbarAddress ?? '—');
          if (p.memo) pdfField(doc, 'Memo', p.memo);
        } else if (d.eventType === 'DONATION_USDC_INTENT') {
          pdfField(doc, 'Amount',    `${p.amount ?? '?'} USDC (pending HashPack signature)`);
          pdfField(doc, 'Token ID',  p.tokenId ?? '0.0.456858');
          pdfField(doc, 'Recipient', p.toAccount ?? '—');
          if (p.memo) pdfField(doc, 'Memo', p.memo);
        } else if (d.eventType === 'DONATION_HBAR') {
          pdfField(doc, 'Amount',    `${p.amount ?? '?'} HBAR`);
          pdfField(doc, 'Recipient', p.toAccount ?? p.hbarAddress ?? '—');
          if (p.txHash) pdfField(doc, 'Tx Hash', p.txHash);
        } else if (d.eventType === 'DONATION_CLPR') {
          pdfField(doc, 'Amount',    `${p.amount ?? '?'} ${p.currency ?? 'CLPR'}`);
          pdfField(doc, 'Address',   p.clprAddress ?? '—');
          if (p.clprTxHash)    pdfField(doc, 'CLPR Tx Hash', p.clprTxHash);
          if (p.clprProofHash) pdfField(doc, 'Proof Hash',   p.clprProofHash);
          if (p.simulated)     pdfField(doc, 'Mode',         'Simulated');
        }
        pdfField(doc, 'Actor',     d.actor ?? '—');
        pdfField(doc, 'Audit ID',  d.auditId ?? '—');
        pdfField(doc, 'Timestamp', d.timestamp ?? p.timestamp ?? '—');
        if (d.hcsSeq != null) pdfField(doc, 'HCS Seq#', String(d.hcsSeq));
        doc.moveDown(0.4);
      }
      pdfDivider(doc);
    }

    if (other.length > 0) {
      pdfSection(doc, 'Other Audit Events');
      for (let i = 0; i < other.length; i++) {
        const e = other[i];
        doc.fontSize(11).font('Helvetica-Bold').text(`${i + 1}. ${e.eventType}`);
        doc.font('Helvetica').fontSize(10);
        pdfField(doc, 'Entity',    e.entityId ?? '—');
        pdfField(doc, 'Actor',     e.actor    ?? '—');
        pdfField(doc, 'Audit ID',  e.auditId  ?? '—');
        pdfField(doc, 'Timestamp', e.timestamp ?? '—');
        const summary = JSON.stringify(e.payload ?? {}).slice(0, 200);
        pdfField(doc, 'Payload',   summary + (summary.length >= 200 ? '…' : ''));
        doc.moveDown(0.4);
      }
    }
  }

  doc.moveDown(2).fontSize(8).fillColor('#888888')
    .text('Generated by CarbonSustain / NatureBackers Enterprise Agent', { align: 'center' })
    .text('All records are immutably stored on the Hedera Consensus Service (HCS)', { align: 'center' });
}

// ── nb_generate_hcs_pdf ───────────────────────────────────────────────────────

class GenerateHcsPdfTool extends BaseHederaQueryTool {
  name = 'nb_generate_hcs_pdf';
  description =
    'Generate a comprehensive PDF audit report for a campaign from all HCS records: ' +
    'campaign creation, final report, and donation payments (HBAR + CLPR). ' +
    'Returns a download URL. Call this when the user wants a downloadable PDF audit report.';
  specificInputSchema = z.object({
    campaignId: z.number().int().min(1).describe('Campaign ID to generate the PDF audit report for.'),
  });
  namespace = 'nature-backers-campaign';

  async executeQuery({ campaignId }) {
    this.logger.info(`NB generate_hcs_pdf campaignId=${campaignId}`);
    // PDF is generated on-demand by GET /api/reports/generate/:campaignId in server.js
    // so it works across Cloud Run instances without any file storage.
    const backendUrl = (process.env.BACKEND_URL || process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
    const downloadUrl = `${backendUrl}/api/reports/generate/${campaignId}`;
    return [
      `PDF Audit Report`,
      ``,
      `Campaign ID:   ${campaignId}`,
      `Download URL:  ${downloadUrl}`,
    ].join('\n');
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class NatureBackersCampaignPlugin extends BasePlugin {
  id      = 'nature-backers-campaign-plugin';
  name    = 'Nature Backers Campaign Plugin';
  description =
    'Full campaign lifecycle management: preview, create, list, detail, assign projects, ' +
    'retrieve votes (DB + Hedera), Merkle proof, push to blockchain, HCS reports on creation and campaign end. ' +
    'Voting is handled externally by the NatureBackers platform — not through the agent.';
  version = '3.0.0';
  author  = 'CarbonSustain';

  #tools = [];

  async initialize(context) {
    await super.initialize(context);
    const cfg = { hederaKit: context.config.hederaKit, logger: context.logger };
    this.#tools = [
      new PreviewCampaignTool(cfg),
      new GetCampaignStatusesTool(cfg),
      new GetDepartmentsTool(cfg),
      new CreateCampaignTool(cfg),
      new GetCampaignsTool(cfg),
      new GetCampaignTool(cfg),
      new SearchNBProjectsTool(cfg),
      new AssignProjectsTool(cfg),
      new GetCampaignVotesTool(cfg),
      new GetHederaVotesTool(cfg),
      new GetVoteProofTool(cfg),
      new PushVotesToHederaTool(cfg),
      new RecordCampaignReportTool(cfg),
      new GetCampaignHcsReportTool(cfg),
      new GetHcsRecordsTool(cfg),
      new GenerateHcsPdfTool(cfg),
      new GetVotesByCampaignTool(cfg),
    ];
  }

  getTools() { return this.#tools; }
}
