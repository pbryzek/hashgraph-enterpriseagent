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
 *   nb_get_campaign_statuses  →  GET  /campaign-status
 *   nb_get_departments        →  GET  /department
 *   nb_create_campaign        →  POST /campaign  (multipart/form-data)
 *   nb_get_campaigns          →  GET  /campaign  (optional statusId filter)
 *   nb_get_campaign           →  GET  /campaign/:id  (full detail incl. projects + departments)
 *   nb_assign_projects        →  POST /campaign-project/assign
 *   nb_get_campaign_votes     →  GET  /vote/campaign-votes/:id  (all votes with user + project)
 *   nb_get_hedera_votes       →  GET  /vote/hedera/:id          (votes from Hedera chain)
 *   nb_get_vote_proof         →  GET  /vote/proof/:id           (Merkle proof)
 *   nb_push_votes_to_hedera   →  POST /vote/hedera/:id          (push approved votes on-chain)
 *   nb_get_votes_by_campaign  →  GET  /campaign/:id + Hedera mirror (decode on-chain tx)
 */

import axios from 'axios';
import { z } from 'zod';
import { BasePlugin, BaseHederaQueryTool } from 'hedera-agent-kit';
import FormData from 'form-data';

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
  d.setDate(d.getDate() + 1);
  d.setUTCHours(8, 0, 0, 0);
  return d.toISOString();
}
function defaultEndDate(startIso) {
  const d = new Date(startIso);
  d.setMonth(d.getMonth() + 1);
  return d.toISOString();
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

const CreateCampaignSchema = z.object({
  name:         z.string().describe('Unique campaign name.'),
  votingStyle:  z.enum(['TOKEN_BASED', 'STORY_FEATURE', 'THEMED_BADGES']).optional()
                 .describe('Voting style. Defaults to STORY_FEATURE.'),
  startDate:    z.string().optional().describe('ISO 8601 start date. Must be in the future.'),
  endDate:      z.string().optional().describe('ISO 8601 end date. Must be after startDate.'),
  emailSubject: z.string().optional().describe('Campaign invitation email subject.'),
  emailBody:    z.string().optional().describe('Campaign invitation email body.'),
  departmentIds: z.array(z.number().int().min(1)).optional()
                  .describe('Department IDs to include. Call nb_get_departments first. Defaults to [1].'),
  imageUrl:     z.string().optional().describe('Public image URL for the campaign banner.'),
});

class CreateCampaignTool extends BaseHederaQueryTool {
  name = 'nb_create_campaign';
  description =
    'Create a new Nature Backers sustainability campaign. ' +
    'Only call after the user has confirmed the projects to feature. ' +
    'Returns the new campaign ID and full campaign object including status, departments, and image URL.';
  specificInputSchema = CreateCampaignSchema;
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

    if (imageUrl) {
      const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 10_000 });
      const contentType = imgResp.headers['content-type'] || 'image/png';
      const ext = contentType.split('/')[1] || 'png';
      form.append('file', Buffer.from(imgResp.data), { filename: `campaign-banner.${ext}`, contentType });
    } else {
      const placeholder = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      );
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

    return [
      `Campaign created successfully!`,
      `Campaign ID:   ${id}`,
      `Name:          ${name}`,
      `Voting Style:  ${resolvedStyle}`,
      `Status:        ${statusName}`,
      `Start:         ${resolvedStart}`,
      `End:           ${resolvedEnd}`,
      `Image URL:     ${campaign?.url ?? '(none)'}`,
      `Departments:\n${depts}`,
      ``,
      `Next step: call nb_assign_projects with campaignId=${id} and the confirmed project IDs.`,
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

class AssignProjectsTool extends BaseHederaQueryTool {
  name = 'nb_assign_projects';
  description =
    'Link one or more sustainability projects to an existing campaign. ' +
    'Call immediately after nb_create_campaign with the NB Project IDs (integers). ' +
    'Returns success/failure count and details for each project assignment.';
  specificInputSchema = z.object({
    campaignId:  z.number().int().min(1).describe('Campaign ID to assign projects to.'),
    projectIds:  z.array(z.union([z.number().int().min(1), z.string()])).min(1)
                   .describe('Array of NB project IDs (integers). Use "NB Project ID" from sp_search_projects.'),
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
    'Full campaign lifecycle management: create, list, detail, assign projects, ' +
    'retrieve votes (DB + Hedera), Merkle proof, push to blockchain';
  version = '2.0.0';
  author  = 'CarbonSustain';

  #tools = [];

  async initialize(context) {
    await super.initialize(context);
    const cfg = { hederaKit: context.config.hederaKit, logger: context.logger };
    this.#tools = [
      new GetCampaignStatusesTool(cfg),
      new GetDepartmentsTool(cfg),
      new CreateCampaignTool(cfg),
      new GetCampaignsTool(cfg),
      new GetCampaignTool(cfg),
      new AssignProjectsTool(cfg),
      new GetCampaignVotesTool(cfg),
      new GetHederaVotesTool(cfg),
      new GetVoteProofTool(cfg),
      new PushVotesToHederaTool(cfg),
      new GetVotesByCampaignTool(cfg),
    ];
  }

  getTools() { return this.#tools; }
}
