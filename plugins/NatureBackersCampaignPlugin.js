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
 *   nb_cast_vote              →  POST /vote  (submit a vote for a project in a campaign)
 *   nb_get_campaign_votes     →  GET  /vote/campaign-votes/:id  (all votes with user + project)
 *   nb_get_hedera_votes       →  GET  /vote/hedera/:id          (votes from Hedera chain)
 *   nb_get_vote_proof         →  GET  /vote/proof/:id           (Merkle proof)
 *   nb_push_votes_to_hedera   →  POST /vote/hedera/:id          (push approved votes on-chain)
 *   nb_record_campaign_report →  Compile final report and submit to HCS
 *   nb_get_campaign_hcs_report→  Retrieve HCS-recorded campaign reports
 *   nb_get_votes_by_campaign  →  GET  /campaign/:id + Hedera mirror (decode on-chain tx)
 */

import axios from 'axios';
import { z } from 'zod';
import { BasePlugin, BaseHederaQueryTool } from 'hedera-agent-kit';
import FormData from 'form-data';
import { recordCrossChainAudit, getAuditLogs } from './crossChainAudit.js';

const NB_BASE_URL = 'https://d3chyxfaxhbtc9.cloudfront.net';

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
    const p = cp.project ?? {};
    return [
      `    - CampaignProject ID: ${cp.id}  Project ID: ${cp.projectId}`,
      p.projectName ? `      Name:        ${p.projectName}` : null,
      p.projectTypes ? `      Type:        ${p.projectTypes}` : null,
      p.projectMethodology ? `      Methodology: ${p.projectMethodology}` : null,
      p.standards?.carbonStandard ? `      Standard:    ${p.standards.carbonStandard}` : null,
      p.status ? `      Status:      ${p.status}` : null,
      p.consensusTimestamp ? `      Timestamp:   ${p.consensusTimestamp}` : null,
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
                  .describe('Department IDs to include. Call nb_get_departments first. Defaults to [1].'),
  imageUrl:     z.string().optional().describe('Public image URL for the campaign banner. Only provide if you have a real, publicly accessible URL. Omit if uncertain — a placeholder will be used automatically.'),
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
    const resolvedDeptIds = departmentIds ?? [1];

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

  async executeQuery({ name, votingStyle, startDate, endDate, emailSubject, emailBody, departmentIds, imageUrl }) {
    const resolvedStyle   = votingStyle   ?? 'STORY_FEATURE';
    const resolvedStart   = startDate     ?? defaultStartDate();
    const resolvedEnd     = endDate       ?? defaultEndDate(resolvedStart);
    const resolvedDeptIds = departmentIds ?? [1];

    this.logger.info(`NB create_campaign "${name}" style=${resolvedStyle}`);

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

    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    const votingUrl   = `${frontendUrl}/vote/${id}`;
    const qrCodeUrl   = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(votingUrl)}`;

    // Record campaign creation on HCS
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

    const hcsLine = audit.hcs?.simulated
      ? `HCS: simulated (set AUDIT_HCS_TOPIC_ID to record on-chain)`
      : `HCS: tx=${audit.hcs?.tx_hash}  seq#=${audit.hcs?.sequenceNumber}`;

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
      `votingUrl: ${votingUrl}`,
      `qrCodeUrl: ${qrCodeUrl}`,
      `auditId: ${audit.summary.auditId}`,
      hcsLine,
    ].join('\n');
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
    'Search the NatureBackers database for projects and return their integer NB Project IDs. ' +
    'Use this to find the correct integer project IDs BEFORE calling nb_assign_projects. ' +
    'sp_search_projects only returns Guardian indexer IDs — this tool returns the NB integer IDs needed for campaign assignment. ' +
    'Optionally filter by a keyword matched against project name or type.';
  specificInputSchema = z.object({
    keyword: z.string().optional().describe('Optional keyword to filter by project name or type (case-insensitive).'),
  });
  namespace = 'nature-backers-campaign';

  async executeQuery({ keyword }) {
    this.logger.info(`NB search_projects keyword="${keyword ?? ''}"`);
    const resp = await axios.get(`${NB_BASE_URL}/project`, { timeout: 15_000 });
    const raw = resp.data?.data ?? resp.data ?? [];

    let projects = Array.isArray(raw) ? raw : [];
    if (keyword) {
      const kw = keyword.toLowerCase();
      projects = projects.filter(p =>
        (p.projectName ?? '').toLowerCase().includes(kw) ||
        (p.projectTypes ?? '').toLowerCase().includes(kw) ||
        (p.primarySector ?? '').toLowerCase().includes(kw)
      );
    }

    if (projects.length === 0) {
      return keyword
        ? `No NB projects found matching "${keyword}". Try a broader keyword or omit it to list all projects.`
        : 'No projects found in the NatureBackers database.';
    }

    const lines = projects.map(p =>
      `- NB Project ID: ${p.id}  |  ${p.projectName ?? 'Unnamed'}` +
      (p.projectTypes ? `  |  Type: ${p.projectTypes}` : '') +
      (p.status ? `  |  Status: ${p.status}` : '')
    );
    return `NatureBackers projects${keyword ? ` matching "${keyword}"` : ''}:\n${lines.join('\n')}`;
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

// ── nb_cast_vote ──────────────────────────────────────────────────────────────

class CastVoteTool extends BaseHederaQueryTool {
  name = 'nb_cast_vote';
  description =
    'Cast a vote for a project in an active Nature Backers campaign. ' +
    'The campaign must have status Active (2). ' +
    'Each user can vote only once per campaign. ' +
    'Requires the userId of the voter (integer from the NatureBackers user database).';
  specificInputSchema = z.object({
    campaignId: z.number().int().min(1).describe('Campaign ID.'),
    projectId:  z.number().int().min(1).describe('Project ID to vote for (must belong to the campaign).'),
    userId:     z.number().int().min(1).describe('Voter user ID from NatureBackers database.'),
    reason:     z.string().optional().describe('Optional reason for the vote (max 500 chars).'),
  });
  namespace = 'nature-backers-campaign';

  async executeQuery({ campaignId, projectId, userId, reason }) {
    this.logger.info(`NB cast_vote campaignId=${campaignId} projectId=${projectId} userId=${userId}`);

    const body = { campaignId, projectId, userId };
    if (reason) body.reason = reason.slice(0, 500);

    const resp = await axios.post(`${NB_BASE_URL}/vote`, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15_000,
    });

    const data = resp.data?.data ?? resp.data;
    const vote = data;

    return [
      `Vote cast successfully!`,
      `Vote ID:    ${vote?.id ?? '?'}`,
      `Campaign:   ${vote?.campaign?.name ?? campaignId}`,
      `Project:    ${vote?.project?.projectName ?? projectId}`,
      `Voter:      ${vote?.user?.first_name ?? ''} ${vote?.user?.last_name ?? ''} (ID: ${userId})`,
      reason ? `Reason:     ${reason}` : null,
      `Timestamp:  ${vote?.createdAt ?? new Date().toISOString()}`,
      ``,
      `The vote has been recorded. It will be pushed to the Hedera blockchain when the campaign is approved.`,
    ].filter(Boolean).join('\n');
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
    'Fetches campaign details and vote summary, generates a structured JSON report, ' +
    'and submits it to HCS for permanent on-chain storage. ' +
    'Returns the HCS transaction hash and audit ID. ' +
    'Call after a campaign is Approved or Completed.';
  specificInputSchema = z.object({
    campaignId: z.number().int().min(1).describe('Campaign ID to generate a report for.'),
    userId:     z.number().int().min(1).describe('Admin user ID for vote retrieval authorization.'),
    note:       z.string().optional().describe('Optional note to include in the report.'),
  });
  namespace = 'nature-backers-campaign';

  async executeQuery({ campaignId, userId, note }) {
    this.logger.info(`NB record_campaign_report campaignId=${campaignId}`);

    const [campResp, votesResp] = await Promise.allSettled([
      axios.get(`${NB_BASE_URL}/campaign/${campaignId}`, { timeout: 15_000 }),
      axios.get(`${NB_BASE_URL}/vote/campaign-votes/${campaignId}`, {
        params: { userId }, timeout: 15_000,
      }),
    ]);

    const campaign = campResp.status === 'fulfilled'
      ? (campResp.value.data?.data ?? campResp.value.data)
      : null;

    const voteData = votesResp.status === 'fulfilled'
      ? (votesResp.value.data?.data ?? votesResp.value.data)
      : null;

    const votes = voteData?.votes ?? [];

    // Tally votes per project
    const projectTally = {};
    for (const v of votes) {
      const key = `${v.projectId}:${v.project?.projectName ?? 'Unknown'}`;
      projectTally[key] = (projectTally[key] ?? 0) + 1;
    }

    const topProject = Object.entries(projectTally).sort((a, b) => b[1] - a[1])[0];

    const report = {
      reportType:    'CAMPAIGN_FINAL_REPORT',
      campaignId,
      campaignName:  campaign?.name ?? 'Unknown',
      status:        campaign?.campaignStatus?.name ?? 'Unknown',
      startDate:     campaign?.startDate ?? null,
      endDate:       campaign?.endDate   ?? null,
      tx_hash:       campaign?.tx_hash   ?? null,
      totalVotes:    voteData?.totalVotes ?? votes.length,
      projectTally,
      winningProject: topProject ? { id: topProject[0].split(':')[0], name: topProject[0].split(':').slice(1).join(':'), votes: topProject[1] } : null,
      projects:      (campaign?.CampaignProject ?? []).map(cp => ({
        projectId:   cp.projectId,
        projectName: cp.project?.projectName ?? 'Unknown',
        votes:       projectTally[`${cp.projectId}:${cp.project?.projectName ?? 'Unknown'}`] ?? 0,
      })),
      generatedAt:   new Date().toISOString(),
      note:          note ?? null,
    };

    const result = await recordCrossChainAudit({
      eventType: 'CAMPAIGN_FINAL_REPORT',
      entityId:  `campaign-${campaignId}`,
      actor:     `admin-${userId}`,
      payload:   report,
      tags:      [`campaign-${campaignId}`, 'final-report'],
    });

    const { auditId, hcs, summary } = result;

    return [
      `Campaign Final Report — Recorded on HCS`,
      ``,
      `Campaign:       ${report.campaignName} (ID: ${campaignId})`,
      `Status:         ${report.status}`,
      `Total Votes:    ${report.totalVotes}`,
      report.winningProject
        ? `Winning Project: ${report.winningProject.name} — ${report.winningProject.votes} vote(s)`
        : `Winning Project: (no votes yet)`,
      ``,
      `Vote Breakdown:`,
      ...report.projects.map(p => `  - ${p.projectName}: ${p.votes} vote(s)`),
      ``,
      `HCS Audit ID:   ${auditId}`,
      `HCS Status:     ${summary.status}`,
      hcs.error ? `HCS Error:      ${hcs.error}` : `HCS tx_hash:    ${hcs.tx_hash}${hcs.simulated ? ' (simulated)' : ''}`,
      `Recorded at:    ${summary.timestamp}`,
    ].join('\n');
  }
}

// ── nb_get_campaign_hcs_report ────────────────────────────────────────────────

class GetCampaignHcsReportTool extends BaseHederaQueryTool {
  name = 'nb_get_campaign_hcs_report';
  description =
    'Retrieve the HCS-recorded final report for a campaign. ' +
    'Searches the audit log for CAMPAIGN_FINAL_REPORT events for the given campaign. ' +
    'If AUDIT_TOPIC_ID is configured, also queries the Hedera mirror node for the raw HCS message. ' +
    'Call nb_record_campaign_report first to create the report if it does not exist yet.';
  specificInputSchema = z.object({
    campaignId: z.number().int().min(1).describe('Campaign ID to retrieve the report for.'),
  });
  namespace = 'nature-backers-campaign';

  async executeQuery({ campaignId }) {
    this.logger.info(`NB get_campaign_hcs_report campaignId=${campaignId}`);

    const entries = getAuditLogs({
      eventType: 'CAMPAIGN_FINAL_REPORT',
      entityId:  `campaign-${campaignId}`,
    });

    if (entries.length === 0) {
      // Try querying the Hedera mirror node if a topic is configured
      const topicId = process.env.AUDIT_TOPIC_ID;
      if (topicId) {
        try {
          const mirrorResp = await axios.get(
            `${mirrorNodeBase()}/api/v1/topics/${topicId}/messages`,
            { params: { limit: 100 }, timeout: 15_000 }
          );
          const msgs = mirrorResp.data?.messages ?? [];
          const matching = msgs.filter(m => {
            try {
              const decoded = Buffer.from(m.message, 'base64').toString('utf8');
              const parsed  = JSON.parse(decoded);
              return parsed?.payload?.campaignId === campaignId &&
                     parsed?.eventType === 'CAMPAIGN_FINAL_REPORT';
            } catch { return false; }
          });

          if (matching.length > 0) {
            const lines = matching.map((m, i) => {
              const decoded = Buffer.from(m.message, 'base64').toString('utf8');
              const parsed  = JSON.parse(decoded);
              const p = parsed.payload ?? {};
              return [
                `Report ${i + 1}: seq#${m.sequence_number}  ts=${m.consensus_timestamp}`,
                `  Campaign: ${p.campaignName}  Status: ${p.status}`,
                `  Total Votes: ${p.totalVotes}`,
                p.winningProject ? `  Winner: ${p.winningProject.name} (${p.winningProject.votes} votes)` : null,
                p.note ? `  Note: ${p.note}` : null,
              ].filter(Boolean).join('\n');
            });
            return [
              `HCS Campaign Report(s) for campaign ${campaignId} — found ${matching.length} on Hedera topic ${topicId}:`,
              '',
              ...lines,
            ].join('\n');
          }
        } catch (err) {
          this.logger.warn(`HCS mirror query failed: ${err.message}`);
        }
      }
      return `No HCS final report found for campaign ${campaignId}. Call nb_record_campaign_report to generate one.`;
    }

    const lines = entries.map((e, i) => {
      const p = e.payload ?? {};
      const hcsLine = e.hcs?.error
        ? `  HCS: FAILED — ${e.hcs.error}`
        : `  HCS: ${e.hcs?.tx_hash ?? '?'}${e.hcs?.simulated ? ' (simulated)' : ''}`;
      return [
        `Report ${i + 1} — Audit ID: ${e.auditId}`,
        `  Campaign: ${p.campaignName ?? campaignId}  Status: ${p.status ?? '?'}`,
        `  Total Votes: ${p.totalVotes ?? '?'}`,
        p.winningProject ? `  Winner: ${p.winningProject.name} (${p.winningProject.votes} votes)` : null,
        `  Vote Breakdown: ${Object.entries(p.projectTally ?? {}).map(([k, v]) => `${k.split(':').slice(1).join(':')} (${v})`).join(', ')}`,
        `  Recorded at: ${e.timestamp}`,
        hcsLine,
        p.note ? `  Note: ${p.note}` : null,
      ].filter(Boolean).join('\n');
    });

    return [
      `HCS Campaign Report(s) for campaign ${campaignId} — ${entries.length} report(s) found:`,
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

// ── Plugin ────────────────────────────────────────────────────────────────────

export class NatureBackersCampaignPlugin extends BasePlugin {
  id      = 'nature-backers-campaign-plugin';
  name    = 'Nature Backers Campaign Plugin';
  description =
    'Full campaign lifecycle management: preview, create, list, detail, assign projects, ' +
    'cast votes, retrieve votes (DB + Hedera), Merkle proof, push to blockchain, HCS reports';
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
      new CastVoteTool(cfg),
      new GetCampaignVotesTool(cfg),
      new GetHederaVotesTool(cfg),
      new GetVoteProofTool(cfg),
      new PushVotesToHederaTool(cfg),
      new RecordCampaignReportTool(cfg),
      new GetCampaignHcsReportTool(cfg),
      new GetVotesByCampaignTool(cfg),
    ];
  }

  getTools() { return this.#tools; }
}
