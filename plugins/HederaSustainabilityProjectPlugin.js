/**
 * HederaSustainabilityProjectPlugin
 *
 * Wraps the Guardian / Hedera global indexer API
 * (same endpoints as cs-indexer-hbar / GlobalIndexer).
 *
 * Base URL  : NATURE_BACKERS_API_URL  (e.g. https://indexer.guardianservice.app/api/v1/mainnet)
 * Auth      : Bearer NATURE_BACKERS_TOKEN
 *
 * Tools:
 *   sp_search_projects   — full-text search + optional SDG / type filter
 *   sp_get_project_detail — fetch one VC document by its consensusTimestamp
 */

import axios from 'axios';
import { z } from 'zod';
import { BasePlugin, BaseHederaQueryTool } from 'hedera-agent-kit';

// ── Helpers ported from cs-indexer-hbar/examples/main.ts ─────────────────────

function isUsable(v) {
  if (!v || typeof v !== 'string') return false;
  const s = v.trim();
  if (!s || s === 'Not specified' || s === 'Not applicable') return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return false;
  return true;
}

function str(v) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function parsePythonList(s) {
  if (!s) return null;
  const t = s.trim();
  if (t.startsWith('[') && t.endsWith(']')) {
    const parts = t.slice(1, -1).split(',').map(p => p.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
  }
  return s;
}

function extractCs(doc) {
  const documents = doc?.item?.documents ?? doc?.documents;
  if (Array.isArray(documents) && documents.length > 0) {
    try {
      const vcDoc = typeof documents[0] === 'string' ? JSON.parse(documents[0]) : documents[0];
      const cs = vcDoc?.credentialSubject;
      if (cs != null) return Array.isArray(cs) ? cs[0] : cs;
    } catch { /* fall through */ }
  }
  for (const c of [doc?.document?.credentialSubject, doc?.vc?.credentialSubject, doc?.credentialSubject]) {
    if (c != null) return Array.isArray(c) ? c[0] : c;
  }
  return null;
}

function extractNameAndDescription(cs) {
  const pd   = cs?.projectDescription;
  const pdet = cs?.project_details;

  const name =
    (typeof pd === 'object' ? str(pd?.name) : null) ??
    str(cs?.projectTitle) ??
    str(cs?.['Project title']) ??
    str(cs?.vcs_project_title) ??
    str(cs?.projectName) ??
    str(cs?.name) ??
    str(cs?.title) ??
    (typeof pdet === 'object' ? str(pdet?.G5) : null) ??
    'N/A';

  const rawDesc =
    (typeof pd === 'object' ? str(pd?.G132) : null) ??
    (typeof pdet === 'object' ? str(pdet?.G132) : null) ??
    str(cs?.['Project Description']) ??
    str(cs?.vcs_project_description) ??
    str(cs?.description) ??
    str(cs?.summary) ??
    'N/A';

  const description = rawDesc !== 'N/A' && rawDesc.length > 250
    ? rawDesc.slice(0, 250) + '...'
    : rawDesc;

  return { name, description };
}

function extractProjectTypes(cs) {
  if (cs?.category && isUsable(cs.category)) return str(cs.category);
  if (cs?.projectTypes) return Array.isArray(cs.projectTypes) ? cs.projectTypes.join(', ') : str(cs.projectTypes);
  if (cs?.projectType) {
    const raw = Array.isArray(cs.projectType) ? cs.projectType.join(', ') : str(cs.projectType);
    return raw ? parsePythonList(raw) : null;
  }
  const fromBlock = (block) => {
    if (typeof block !== 'object' || block === null) return null;
    const vcsTypes = block?.registry_vcs?.vcs_additional_project_types;
    if (Array.isArray(vcsTypes)) {
      const usable = vcsTypes.filter(isUsable);
      if (usable.length > 0) return usable.join(', ');
    }
    const g143 = block?.G143;
    if (typeof g143 === 'object' && isUsable(g143?.G6)) return str(g143.G6);
    if (isUsable(block?.registry_ccb?.ccb_project_type)) return str(block.registry_ccb.ccb_project_type);
    return null;
  };
  return fromBlock(cs?.projectDescription) ?? fromBlock(cs?.project_details) ??
    str(cs?.project_type) ?? str(cs?.type_of_project) ?? null;
}

function extractSdgs(cs) {
  const raw = cs?.impactAndRiskSdgs;
  if (Array.isArray(raw) && raw.length > 0) return raw;
  for (const block of [cs?.projectDescription, cs?.project_details]) {
    if (typeof block === 'object' && block !== null) {
      const nested = block?.impactAndRiskSdgs;
      if (Array.isArray(nested) && nested.length > 0) return nested;
    }
  }
  return [];
}

function extractLocation(cs) {
  return str(cs?.country) ?? str(cs?.projectCountry) ?? str(cs?.location) ??
    str(cs?.region) ?? str(cs?.['Project Country']) ?? null;
}

function isProjectSchema(schemaName) {
  if (!schemaName) return false;
  if (schemaName.includes('Developer Application')) return false;
  return schemaName.startsWith('Project') || schemaName.startsWith('Parent: Project');
}

function formatProject(item, index) {
  const hederaId = item.consensusTimestamp ?? item.uuid ?? `item-${index}`;
  const nbId     = item.nbProjectId ?? null;
  const cs  = extractCs(item) ?? {};
  const { name, description } = extractNameAndDescription(cs);
  const types = extractProjectTypes(cs);
  const sdgs  = extractSdgs(cs);
  const loc   = extractLocation(cs);

  return [
    `${index + 1}. ${name}`,
    nbId    && `   NB Project ID (use for campaign assignment): ${nbId}`,
    `   Hedera ID: ${hederaId}`,
    description !== 'N/A' && `   Description: ${description}`,
    types   && `   Type: ${types}`,
    sdgs.length > 0 && `   SDGs: ${sdgs.slice(0, 3).join(', ')}`,
    loc     && `   Location: ${loc}`,
  ].filter(Boolean).join('\n');
}

// ── Fake data (used when FAKE_INDEXER=true) ───────────────────────────────────

// nbProjectId is the integer ID in the Nature Backers DB — used for nb_assign_projects.
// consensusTimestamp is the Hedera indexer ID — used for sp_get_project_detail.
const FAKE_PROJECTS = [
  {
    nbProjectId: 1,
    consensusTimestamp: '1700000001.000000000',
    uuid: 'fake-proj-001',
    analytics: { schemaName: 'Project', policyId: 'fake-policy-001' },
    documents: [JSON.stringify({
      credentialSubject: {
        projectName: 'Karura Urban Forest Restoration — Nairobi, Kenya',
        description: 'Reforesting degraded urban land in Nairobi with native species to restore biodiversity and improve soil health.',
        projectType: 'Reforestation',
        country: 'Kenya',
        impactAndRiskSdgs: ['SDG 13 - Climate Action', 'SDG 15 - Life on Land'],
      }
    })],
  },
  {
    nbProjectId: 2,
    consensusTimestamp: '1700000002.000000000',
    uuid: 'fake-proj-002',
    analytics: { schemaName: 'Project', policyId: 'fake-policy-002' },
    documents: [JSON.stringify({
      credentialSubject: {
        projectName: 'Niger Delta Biochar Soil Enhancement Programme',
        description: 'Applying biochar to degraded agricultural soils in Nigeria to sequester carbon and improve food security.',
        projectType: 'Biochar',
        country: 'Nigeria',
        impactAndRiskSdgs: ['SDG 2 - Zero Hunger', 'SDG 13 - Climate Action'],
      }
    })],
  },
  {
    nbProjectId: 3,
    consensusTimestamp: '1700000003.000000000',
    uuid: 'fake-proj-003',
    analytics: { schemaName: 'Project', policyId: 'fake-policy-003' },
    documents: [JSON.stringify({
      credentialSubject: {
        projectName: 'Lake Tanganyika Wetland Conservation & Blue Carbon',
        description: 'Protecting and restoring coastal wetlands around Lake Tanganyika to sequester blue carbon and safeguard freshwater.',
        projectType: 'Wetland Restoration',
        country: 'Tanzania',
        impactAndRiskSdgs: ['SDG 6 - Clean Water', 'SDG 13 - Climate Action', 'SDG 14 - Life Below Water'],
      }
    })],
  },
  {
    nbProjectId: 4,
    consensusTimestamp: '1700000004.000000000',
    uuid: 'fake-proj-004',
    analytics: { schemaName: 'Project', policyId: 'fake-policy-004' },
    documents: [JSON.stringify({
      credentialSubject: {
        projectName: 'Rajasthan Solar Micro-Grid Rural Electrification',
        description: 'Deploying solar micro-grids in off-grid villages across Rajasthan, India, displacing diesel generation.',
        projectType: 'Renewable Energy',
        country: 'India',
        impactAndRiskSdgs: ['SDG 7 - Affordable and Clean Energy', 'SDG 13 - Climate Action'],
      }
    })],
  },
  {
    nbProjectId: 5,
    consensusTimestamp: '1700000005.000000000',
    uuid: 'fake-proj-005',
    analytics: { schemaName: 'Project', policyId: 'fake-policy-005' },
    documents: [JSON.stringify({
      credentialSubject: {
        projectName: 'Amazon Indigenous Community REDD+ Forest Guardian',
        description: 'Empowering indigenous communities in the Brazilian Amazon to prevent deforestation through REDD+ carbon finance.',
        projectType: 'REDD+',
        country: 'Brazil',
        impactAndRiskSdgs: ['SDG 13 - Climate Action', 'SDG 15 - Life on Land', 'SDG 10 - Reduced Inequalities'],
      }
    })],
  },
];

function typeKeywords(type) {
  const stems = new Set();
  for (const word of type.toLowerCase().trim().split(/\s+/)) {
    stems.add(word);
    if (word.endsWith('ies'))      stems.add(word.slice(0, -3) + 'y');
    else if (word.endsWith('es')) stems.add(word.slice(0, -2));
    else if (word.endsWith('s'))  stems.add(word.slice(0, -1));
  }
  return [...stems];
}

function fakeSearch({ query, sdgs, type }) {
  let results = FAKE_PROJECTS;

  // Text query — stem each word so "wetlands" matches "wetland"
  if (query) {
    const keywords = typeKeywords(query);
    results = results.filter(p => {
      const hay = JSON.stringify(p).toLowerCase();
      return keywords.some(kw => hay.includes(kw));
    });
  }

  // SDG filter
  if (sdgs && sdgs.length > 0) {
    const terms = sdgs.map(s => s.toLowerCase());
    results = results.filter(p => {
      const hay = JSON.stringify(p).toLowerCase();
      return terms.some(t => hay.includes(t));
    });
  }

  // Type filter with stemming
  if (type) {
    const keywords = typeKeywords(type);
    results = results.filter(p => {
      const hay = JSON.stringify(p).toLowerCase();
      return keywords.some(kw => hay.includes(kw));
    });
  }

  return results;
}

// ── sp_search_projects ────────────────────────────────────────────────────────

const SearchProjectsSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      'Free-text search query sent to the Hedera indexer. ' +
      'Examples: "wetland restoration", "biochar Kenya", "SDG 13 reforestation".'
    ),
  type: z
    .string()
    .optional()
    .describe(
      'Project type filter keyword, e.g. "wetlands", "reforestation", "biochar", "solar", "REDD+". ' +
      'Applied after the main search to narrow results.'
    ),
  sdgs: z
    .array(z.string())
    .optional()
    .describe(
      'SDG label filters, e.g. ["climate action", "clean water", "life on land"]. ' +
      'Matched against the full text of each result.'
    ),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Max results to return (default 10).'),
});

class SearchProjectsTool extends BaseHederaQueryTool {
  name = 'sp_search_projects';
  description =
    'Search the Hedera Guardian indexer for nature-based carbon and sustainability projects. ' +
    'Returns project names, types, SDGs, locations and consensus timestamps (used as project IDs). ' +
    'Always call this before creating a campaign to identify the projects to feature.';
  specificInputSchema = SearchProjectsSchema;
  namespace = 'sustainability-projects';

  #client;

  constructor(params) {
    super(params);
    this.#client = axios.create({
      baseURL: process.env.NATURE_BACKERS_API_URL,
      timeout: 20_000,
      headers: { Authorization: `Bearer ${process.env.NATURE_BACKERS_TOKEN}` },
    });
  }

  async executeQuery({ query, type, sdgs, pageSize = 10 }) {
    this.logger.info(`SP search_projects query="${query}" type="${type}" sdgs=${JSON.stringify(sdgs)}`);

    let items;

    const useFake = process.env.FAKE_INDEXER === 'true';

    if (useFake) {
      this.logger.info('SP: FAKE_INDEXER mode');
      items = fakeSearch({ query, sdgs, type });
    } else {
      const searchTerm = query || [type, ...(sdgs ?? [])].filter(Boolean).join(' ');
      if (!searchTerm) return 'Please provide a query, type, or SDG to search for projects.';

      try {
        const resp = await this.#client.get('/search', {
          params: { search: searchTerm, pageIndex: 0, pageSize },
        });
        const raw = resp.data;
        items = Array.isArray(raw) ? raw : (raw?.items ?? []);
        items = items.filter(i => isProjectSchema(i?.analytics?.schemaName));

        if (type) {
          const keywords = typeKeywords(type);
          items = items.filter(p => keywords.some(kw => JSON.stringify(p).toLowerCase().includes(kw)));
        }
        if (sdgs && sdgs.length > 0) {
          const terms = sdgs.map(s => s.toLowerCase());
          items = items.filter(p => terms.some(t => JSON.stringify(p).toLowerCase().includes(t)));
        }
      } catch (err) {
        const status = err?.response?.status;
        if (status === 401 || status === 403) {
          this.logger.warn(`SP: indexer returned ${status} — falling back to demo data. Refresh NATURE_BACKERS_TOKEN.`);
          items = fakeSearch({ query, sdgs, type });
        } else {
          throw err;
        }
      }
    }

    if (items.length === 0) {
      return (
        `No projects found for: query="${query ?? ''}" type="${type ?? ''}" sdgs=${JSON.stringify(sdgs ?? [])}.\n` +
        `Try a broader query or different keywords.`
      );
    }

    const lines = items.slice(0, pageSize).map((p, i) => formatProject(p, i));
    return `Found ${items.length} project(s) (showing ${Math.min(items.length, pageSize)}):\n\n${lines.join('\n\n')}`;
  }
}

// ── sp_get_project_detail ─────────────────────────────────────────────────────

const GetProjectDetailSchema = z.object({
  messageId: z
    .string()
    .describe(
      'The consensusTimestamp or UUID of the project VC to retrieve, ' +
      'as returned by sp_search_projects (e.g. "1700000003.000000000").'
    ),
});

class GetProjectDetailTool extends BaseHederaQueryTool {
  name = 'sp_get_project_detail';
  description =
    'Retrieve the full VC document for a specific Hedera indexer project by its consensusTimestamp or UUID. ' +
    'Use this to show complete project details before presenting to the user for confirmation.';
  specificInputSchema = GetProjectDetailSchema;
  namespace = 'sustainability-projects';

  #client;

  constructor(params) {
    super(params);
    this.#client = axios.create({
      baseURL: process.env.NATURE_BACKERS_API_URL,
      timeout: 15_000,
      headers: { Authorization: `Bearer ${process.env.NATURE_BACKERS_TOKEN}` },
    });
  }

  async executeQuery({ messageId }) {
    this.logger.info(`SP get_project_detail id=${messageId}`);

    let doc;
    if (process.env.FAKE_INDEXER === 'true') {
      doc = FAKE_PROJECTS.find(p => p.consensusTimestamp === messageId || p.uuid === messageId) ?? null;
    } else {
      try {
        const resp = await this.#client.get(`/entities/vc-documents/${encodeURIComponent(messageId)}`);
        doc = resp.data;
      } catch (err) {
        const status = err?.response?.status;
        if (status === 401 || status === 403) {
          this.logger.warn(`SP: indexer returned ${status} — falling back to demo data.`);
          doc = FAKE_PROJECTS.find(p => p.consensusTimestamp === messageId || p.uuid === messageId) ?? null;
        } else {
          throw err;
        }
      }
    }

    if (!doc) return `No project found with ID: ${messageId}`;

    const cs = extractCs(doc) ?? {};
    const { name, description } = extractNameAndDescription(cs);
    const types = extractProjectTypes(cs);
    const sdgs  = extractSdgs(cs);
    const loc   = extractLocation(cs);

    return [
      `Project ID (consensusTimestamp): ${messageId}`,
      `Name: ${name}`,
      description !== 'N/A' && `Description: ${description}`,
      types && `Type: ${types}`,
      sdgs.length > 0 && `SDGs: ${sdgs.join(', ')}`,
      loc && `Location: ${loc}`,
    ].filter(Boolean).join('\n');
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class HederaSustainabilityProjectPlugin extends BasePlugin {
  id      = 'hedera-sustainability-project-plugin';
  name    = 'Hedera Sustainability Project Plugin';
  description = 'Searches the Hedera Guardian indexer for nature-based sustainability projects';
  version = '2.0.0';
  author  = 'CarbonSustain';

  #tools = [];

  async initialize(context) {
    await super.initialize(context);
    this.#tools = [
      new SearchProjectsTool({ hederaKit: context.config.hederaKit, logger: context.logger }),
      new GetProjectDetailTool({ hederaKit: context.config.hederaKit, logger: context.logger }),
    ];
  }

  getTools() { return this.#tools; }
}
