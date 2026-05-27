/**
 * NatureBackersCampaignPlugin — creates and manages Nature Backers campaigns
 * via the Nature Backers REST API at https://d3chyxfaxhbtc9.cloudfront.net
 *
 * Tools:
 *   nb_get_departments       →  GET  /department          (discover valid dept IDs)
 *   nb_create_campaign       →  POST /campaign            (multipart/form-data)
 *   nb_get_campaigns         →  GET  /campaign
 *   nb_assign_projects       →  POST /campaign-project/assign
 *   nb_get_votes_by_campaign →  GET  /campaign/{id}       (extracts tx_hash → Hedera mirror node)
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
 *
 * Encoding layout (after 4-byte selector):
 *   slot 0  [bytes   0-31]  → byte offset to campaignKey string
 *   slot 1  [bytes  32-63]  → departmentId (uint256)
 *   slot 2  [bytes  64-95]  → byte offset to voterEmail string
 *   slot 3  [bytes  96-127] → reserved uint256
 *   slot 4  [bytes 128-159] → byte offset to voteJson string
 *   <string data at the offsets above: 32-byte length prefix + UTF-8 bytes>
 */
function decodeVoteParams(functionParams) {
  if (!functionParams || functionParams.length < 10) return null;
  // strip 0x prefix + 4-byte (8 hex char) selector
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
    const off0 = uint256AtByte(0);    // offset → campaignKey
    const deptId = uint256AtByte(32); // departmentId
    const off2 = uint256AtByte(64);   // offset → voterEmail
    const off4 = uint256AtByte(128);  // offset → voteJson

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

// ── nb_get_departments ────────────────────────────────────────────────────────

const GetDepartmentsSchema = z.object({});

class GetDepartmentsTool extends BaseHederaQueryTool {
  name = 'nb_get_departments';
  description =
    'List all available departments and their numeric IDs from the Nature Backers platform. ' +
    'Call this before nb_create_campaign to discover which departmentIds to use.';
  specificInputSchema = GetDepartmentsSchema;
  namespace = 'nature-backers-campaign';

  async executeQuery() {
    this.logger.info('NB get_departments');
    const resp = await axios.get(`${NB_BASE_URL}/department`, { timeout: 15_000 });
    const items = resp.data?.data ?? resp.data ?? [];

    if (!Array.isArray(items) || items.length === 0) return 'No departments found.';

    const lines = items.map(d => `  ID ${d.id}: ${d.name}`);
    return `Available departments (use these IDs in nb_create_campaign):\n${lines.join('\n')}`;
  }
}

// ── nb_create_campaign ────────────────────────────────────────────────────────

const CreateCampaignSchema = z.object({
  name: z.string().describe('Unique campaign name.'),
  votingStyle: z
    .enum(['TOKEN_BASED', 'STORY_FEATURE', 'THEMED_BADGES'])
    .optional()
    .describe(
      'Voting style. STORY_FEATURE = story-driven voting (default). ' +
      'TOKEN_BASED = token-weighted. THEMED_BADGES = badge-based.'
    ),
  startDate: z
    .string()
    .optional()
    .describe(
      'Campaign start date in ISO 8601 format, e.g. "2025-09-01T08:00:00.000Z". ' +
      'Must be in the future. Defaults to tomorrow at 08:00 UTC if omitted.'
    ),
  endDate: z
    .string()
    .optional()
    .describe(
      'Campaign end date in ISO 8601 format. Must be after startDate. ' +
      'Defaults to one month after startDate if omitted.'
    ),
  emailSubject: z.string().optional().describe('Subject line for the campaign invitation email.'),
  emailBody: z.string().optional().describe('Body text for the campaign invitation email.'),
  departmentIds: z
    .array(z.number().int().min(1))
    .optional()
    .describe(
      'Array of department IDs to include in the campaign. ' +
      'Call nb_get_departments first to discover valid IDs. Defaults to [1] if omitted.'
    ),
  imageUrl: z
    .string()
    .optional()
    .describe(
      'Public URL of an image to use as the campaign banner. ' +
      'A placeholder is used if omitted.'
    ),
});

class CreateCampaignTool extends BaseHederaQueryTool {
  name = 'nb_create_campaign';
  description =
    'Create a new Nature Backers sustainability campaign. ' +
    'ONLY call this after the user has confirmed the projects they want to feature. ' +
    'All fields except name are optional — sensible defaults are applied automatically. ' +
    'Do NOT use this to source or search for projects — use sp_search_projects instead.';
  specificInputSchema = CreateCampaignSchema;
  namespace = 'nature-backers-campaign';

  async executeQuery({ name, votingStyle, startDate, endDate, emailSubject, emailBody, departmentIds, imageUrl }) {
    const resolvedStyle   = votingStyle   ?? 'STORY_FEATURE';
    const resolvedStart   = startDate     ?? defaultStartDate();
    const resolvedEnd     = endDate       ?? defaultEndDate(resolvedStart);
    const resolvedDeptIds = departmentIds ?? [1];

    this.logger.info(`NB create_campaign "${name}" style=${resolvedStyle} start=${resolvedStart}`);

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
      const placeholderPng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      );
      form.append('file', placeholderPng, { filename: 'placeholder.png', contentType: 'image/png' });
    }

    const resp = await axios.post(`${NB_BASE_URL}/campaign`, form, {
      headers: form.getHeaders(),
      timeout: 20_000,
    });

    const campaign = resp.data?.data ?? resp.data;
    const id = campaign?.id ?? campaign?.campaignId ?? '?';
    return (
      `Campaign created successfully!\n` +
      `Campaign ID: ${id}\n` +
      `Name: ${name}\n` +
      `Voting Style: ${resolvedStyle}\n` +
      `Start: ${resolvedStart}  End: ${resolvedEnd}\n\n` +
      `Next step: call nb_assign_projects with campaignId=${id} and the confirmed project IDs.`
    );
  }
}

// ── nb_get_campaigns ──────────────────────────────────────────────────────────

const GetCampaignsSchema = z.object({});

class GetCampaignsTool extends BaseHederaQueryTool {
  name = 'nb_get_campaigns';
  description =
    'List all existing Nature Backers campaigns. ' +
    'Use to check existing campaigns or find a campaign ID for follow-up operations.';
  specificInputSchema = GetCampaignsSchema;
  namespace = 'nature-backers-campaign';

  async executeQuery() {
    this.logger.info('NB get_campaigns');
    const resp = await axios.get(`${NB_BASE_URL}/campaign`, { timeout: 15_000 });
    const items = resp.data?.data ?? resp.data ?? [];

    if (!Array.isArray(items) || items.length === 0) return 'No campaigns found.';

    const lines = items.map((c, i) => {
      const id    = c.id ?? '?';
      const name  = c.name ?? `Campaign ${i + 1}`;
      const style = c.votingStyle ?? '';
      const start = c.startDate ? new Date(c.startDate).toDateString() : '';
      const end   = c.endDate   ? new Date(c.endDate).toDateString()   : '';
      return `${i + 1}. [ID: ${id}] ${name}${style ? `  (${style})` : ''}${start ? `  ${start} → ${end}` : ''}`;
    });

    return `${items.length} campaign(s):\n${lines.join('\n')}`;
  }
}

// ── nb_assign_projects ────────────────────────────────────────────────────────

const AssignProjectsSchema = z.object({
  campaignId: z.number().int().min(1).describe('Numeric ID of the campaign to assign projects to.'),
  projectIds: z
    .array(z.union([z.number().int().min(1), z.string()]))
    .min(1)
    .describe(
      'Array of NB project IDs (integers) to link to the campaign. ' +
      'Use the "NB Project ID" shown in sp_search_projects results, NOT the Hedera consensus timestamp.'
    ),
});

class AssignProjectsTool extends BaseHederaQueryTool {
  name = 'nb_assign_projects';
  description =
    'Link one or more sustainability projects to an existing Nature Backers campaign. ' +
    'Call this immediately after nb_create_campaign to associate the confirmed projects.';
  specificInputSchema = AssignProjectsSchema;
  namespace = 'nature-backers-campaign';

  async executeQuery({ campaignId, projectIds }) {
    // Coerce to integers — the agent may pass numeric strings from Hedera IDs
    const intIds = projectIds.map(id => {
      const n = typeof id === 'number' ? id : parseInt(String(id), 10);
      return isNaN(n) ? null : n;
    }).filter(Boolean);

    if (intIds.length === 0) {
      return (
        'Could not assign projects: the provided project IDs could not be parsed as integers. ' +
        'Use the "NB Project ID" (integer) shown in the search results, not the Hedera consensus timestamp.'
      );
    }

    this.logger.info(`NB assign_projects campaignId=${campaignId} projects=${JSON.stringify(intIds)}`);

    const resp = await axios.post(
      `${NB_BASE_URL}/campaign-project/assign`,
      { campaignId, projectIds: intIds },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15_000 }
    );

    const result = resp.data;
    const count  = result?.data?.successCount ?? result?.successCount ?? projectIds.length;
    return (
      `Successfully assigned ${count} project(s) to campaign ${campaignId}.\n` +
      `Project IDs: ${projectIds.join(', ')}`
    );
  }
}

// ── nb_get_votes_by_campaign ──────────────────────────────────────────────────

const GetVotesByCampaignSchema = z.object({
  campaignId: z.number().int().min(1).describe('Numeric ID of the campaign to retrieve votes for.'),
});

class GetVotesByCampaignTool extends BaseHederaQueryTool {
  name = 'nb_get_votes_by_campaign';
  description =
    'Retrieve on-chain vote data for a Nature Backers campaign. ' +
    'Fetches the campaign from the NB API, extracts its tx_hash, then queries the ' +
    'Hedera mirror node to decode the vote recorded in the smart contract call. ' +
    'Returns voter info, project voted for, reason, timestamps, and Hedera transaction details.';
  specificInputSchema = GetVotesByCampaignSchema;
  namespace = 'nature-backers-campaign';

  async executeQuery({ campaignId }) {
    this.logger.info(`NB get_votes_by_campaign campaignId=${campaignId}`);

    // Step 1 — fetch campaign detail (includes tx_hash)
    const campResp = await axios.get(`${NB_BASE_URL}/campaign/${campaignId}`, { timeout: 15_000 });
    const campaign = campResp.data?.data ?? campResp.data;

    if (!campaign) return `Campaign ${campaignId} not found.`;

    const txHash = campaign.tx_hash;
    if (!txHash) {
      return (
        `Campaign "${campaign.name}" (ID: ${campaignId}) has no on-chain votes recorded yet.\n` +
        `Voting style: ${campaign.votingStyle || 'unknown'}\n` +
        `Period: ${campaign.startDate?.slice(0,10)} → ${campaign.endDate?.slice(0,10)}`
      );
    }

    // Step 2 — query Hedera mirror node for the EVM contract result
    let contractResult;
    try {
      const mirrorResp = await axios.get(
        `${mirrorNodeBase()}/api/v1/contracts/results/${txHash}`,
        { timeout: 15_000 }
      );
      contractResult = mirrorResp.data;
    } catch (err) {
      return (
        `Campaign "${campaign.name}" (ID: ${campaignId})\n` +
        `tx_hash found but Hedera mirror node lookup failed: ${err.message}\n` +
        `tx_hash: ${txHash}`
      );
    }

    // Step 3 — decode ABI-encoded vote payload from function_parameters
    const decoded = decodeVoteParams(contractResult.function_parameters);
    const vote = decoded?.vote;

    const lines = [
      `Campaign: "${campaign.name}" (ID: ${campaignId})`,
      `Voting style: ${campaign.votingStyle || 'unknown'}`,
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
      lines.push('');
      lines.push(`── Decoded Vote ──`);
      lines.push(`Vote ID:       ${vote.voteId}`);
      lines.push(`Voter:         ${vote.userName} (user ID ${vote.userId})`);
      if (decoded.voterEmail) lines.push(`Voter email:   ${decoded.voterEmail}`);
      lines.push(`Project voted: ${vote.projectName} (project ID ${vote.projectId})`);
      lines.push(`Department:    ${decoded.departmentId}`);
      lines.push(`Reason:        ${vote.reason || '(none)'}`);
      lines.push(`Recorded at:   ${vote.createdAt}`);
    } else if (contractResult.function_parameters) {
      lines.push('');
      lines.push('(Vote payload present but could not be decoded — raw function_parameters available)');
    }

    return lines.join('\n');
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class NatureBackersCampaignPlugin extends BasePlugin {
  id      = 'nature-backers-campaign-plugin';
  name    = 'Nature Backers Campaign Plugin';
  description = 'Creates and manages Nature Backers sustainability campaigns via the Nature Backers REST API';
  version = '1.0.0';
  author  = 'CarbonSustain';

  #tools = [];

  async initialize(context) {
    await super.initialize(context);
    this.#tools = [
      new GetDepartmentsTool({ hederaKit: context.config.hederaKit, logger: context.logger }),
      new CreateCampaignTool({ hederaKit: context.config.hederaKit, logger: context.logger }),
      new GetCampaignsTool({ hederaKit: context.config.hederaKit, logger: context.logger }),
      new AssignProjectsTool({ hederaKit: context.config.hederaKit, logger: context.logger }),
      new GetVotesByCampaignTool({ hederaKit: context.config.hederaKit, logger: context.logger }),
    ];
  }

  getTools() {
    return this.#tools;
  }
}
