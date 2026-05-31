/**
 * HederaSustainabilityProjectPlugin
 *
 * Wraps the Guardian / Hedera global indexer API.
 * Ported from cs-indexer-hbar reference implementation.
 *
 * Base URL  : NATURE_BACKERS_API_URL
 * Auth      : Bearer NATURE_BACKERS_TOKEN
 *
 * Tools:
 *   sp_search_projects    — search by SDG number, keyword, or type
 *   sp_get_project_detail — full VC document by consensusTimestamp
 */

import axios from 'axios';
import { z } from 'zod';
import { BasePlugin, BaseHederaQueryTool } from 'hedera-agent-kit';

// ── SDG map & keywords (ported from cs-indexer-hbar/src/matchProject.ts & sdg_keywords.ts) ──

const SDG_MAP = {
  'SDG 1': 'No Poverty',
  'SDG 2': 'Zero Hunger',
  'SDG 3': 'Good Health and Well-being',
  'SDG 4': 'Quality Education',
  'SDG 5': 'Gender Equality',
  'SDG 6': 'Clean Water and Sanitation',
  'SDG 7': 'Affordable and Clean Energy',
  'SDG 8': 'Decent Work and Economic Growth',
  'SDG 9': 'Industry, Innovation and Infrastructure',
  'SDG 10': 'Reduced Inequalities',
  'SDG 11': 'Sustainable Cities and Communities',
  'SDG 12': 'Responsible Consumption and Production',
  'SDG 13': 'Climate Action',
  'SDG 14': 'Life Below Water',
  'SDG 15': 'Life on Land',
  'SDG 16': 'Peace, Justice and Strong Institutions',
  'SDG 17': 'Partnerships for the Goals',
};

const SDG_KEYWORDS = {
  SDG1_No_Poverty: { elsevier: ['poverty', 'income inequality', 'economic vulnerability', 'social safety net', 'minimum wage', 'unemployment', 'financial inclusion'], auckland: ['poverty eradication', 'multidimensional poverty', 'social protection', 'basic income'] },
  SDG2_Zero_Hunger: { elsevier: ['food security', 'malnutrition', 'agricultural productivity', 'crop yield', 'sustainable agriculture', 'nutrition deficiency'], auckland: ['hunger reduction', 'undernourishment', 'small-scale farmers', 'food accessibility'] },
  SDG3_Good_Health_and_Wellbeing: { elsevier: ['public health', 'healthcare access', 'mental health', 'maternal mortality', 'vaccination', 'communicable diseases', 'noncommunicable diseases'], auckland: ['health outcomes', 'preventive care', 'universal health coverage', 'child mortality'] },
  SDG4_Quality_Education: { elsevier: ['education access', 'literacy', 'early childhood education', 'STEM education', 'higher education', 'inclusive education'], auckland: ['educational equity', 'lifelong learning', 'teacher training', 'digital literacy'] },
  SDG5_Gender_Equality: { elsevier: ['gender equality', 'women empowerment', 'gender-based violence', 'equal pay', 'female leadership', 'reproductive rights'], auckland: ['gender discrimination', 'gender parity', 'women in STEM', 'female education'] },
  SDG6_Clean_Water_and_Sanitation: { elsevier: ['clean water', 'sanitation', 'wastewater treatment', 'water scarcity', 'water quality', 'safe drinking water'], auckland: ['hygiene access', 'water infrastructure', 'water conservation', 'WASH services'] },
  SDG7_Affordable_and_Clean_Energy: { elsevier: ['renewable energy', 'solar power', 'wind energy', 'clean energy access', 'energy efficiency', 'sustainable energy'], auckland: ['off-grid energy', 'energy poverty', 'green technology', 'bioenergy'] },
  SDG8_Decent_Work_and_Economic_Growth: { elsevier: ['economic growth', 'decent work', 'employment', 'job creation', 'informal economy', 'labor rights'], auckland: ['youth unemployment', 'inclusive growth', 'productivity', 'entrepreneurship'] },
  SDG9_Industry_Innovation_and_Infrastructure: { elsevier: ['infrastructure', 'sustainable industry', 'innovation', 'technology development', 'resilient infrastructure', 'R&D'], auckland: ['digital infrastructure', 'industrialization', 'tech startups', 'smart manufacturing'] },
  SDG10_Reduced_Inequalities: { elsevier: ['social inclusion', 'economic inequality', 'discrimination', 'marginalized communities', 'income distribution', 'equal opportunity'], auckland: ['refugees', 'LGBTQ+ rights', 'ethnic minorities', 'intergenerational mobility'] },
  SDG11_Sustainable_Cities_and_Communities: { elsevier: ['urban development', 'smart cities', 'affordable housing', 'public transport', 'urban resilience', 'sustainable urbanization'], auckland: ['green buildings', 'urban planning', 'community engagement', 'urban poverty'] },
  SDG12_Responsible_Consumption_and_Production: { elsevier: ['sustainable consumption', 'waste management', 'circular economy', 'eco-efficiency', 'resource efficiency', 'consumer behavior'], auckland: ['green supply chain', 'product lifecycle', 'industrial symbiosis', 'waste reduction'] },
  SDG13_Climate_Action: { elsevier: ['climate change', 'carbon emissions', 'greenhouse gases', 'GHG reduction', 'climate policy', 'resilience', 'climate adaptation'], auckland: ['extreme weather', 'climate resilience', 'climate mitigation', 'carbon footprint'] },
  SDG14_Life_Below_Water: { elsevier: ['marine conservation', 'ocean pollution', 'overfishing', 'marine biodiversity', 'coral reefs', 'sustainable fisheries'], auckland: ['marine ecosystems', 'plastic waste', 'aquatic habitats', 'marine protected areas'] },
  SDG15_Life_on_Land: { elsevier: ['deforestation', 'reforestation', 'biodiversity', 'land degradation', 'ecosystem restoration', 'forest conservation'], auckland: ['protected areas', 'terrestrial ecosystems', 'land use change', 'wildlife habitat'] },
  SDG16_Peace_Justice_and_Strong_Institutions: { elsevier: ['rule of law', 'access to justice', 'corruption', 'human rights', 'violence prevention', 'strong institutions'], auckland: ['judicial reform', 'civil liberties', 'freedom of expression', 'peacebuilding'] },
  SDG17_Partnerships_for_the_Goals: { elsevier: ['global partnerships', 'international cooperation', 'capacity building', 'multilateralism', 'foreign aid', 'public-private partnerships'], auckland: ['technology transfer', 'cross-sector collaboration', 'development finance', 'policy coherence'] },
};

function getSdgTermKeywords(sdgNumber) {
  const sdgCode = `SDG ${sdgNumber}`;
  const description = SDG_MAP[sdgCode];
  const entry = Object.entries(SDG_KEYWORDS).find(([k]) => k.startsWith(`SDG${sdgNumber}_`));
  return [
    sdgCode,
    `SDG${sdgNumber}`,
    ...(description ? [description] : []),
    ...(entry ? [...entry[1].elsevier, ...entry[1].auckland] : []),
  ];
}

function filterProjectBySDGs(text, sdgNumbers) {
  if (!text || !sdgNumbers?.length) return false;
  const lower = text.toLowerCase();
  const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const sdgNumber of sdgNumbers) {
    const sdgCode = `SDG ${sdgNumber}`;
    const description = SDG_MAP[sdgCode] ?? '';
    const sdgNum = String(sdgNumber);

    if (new RegExp(`\\b${escapeRegex(sdgCode.toLowerCase())}\\b`, 'i').test(lower)) return true;
    if (new RegExp(`\\bSDG${sdgNum}\\b`, 'i').test(lower)) return true;
    if (description && new RegExp(`\\b${escapeRegex(description.toLowerCase())}\\b`, 'i').test(lower)) return true;

    // comma-separated list: "SDG 1, 2, 13"
    const listRe = /sdg\s*((\d{1,2}[\s,]*(and\s*)?)*)/gi;
    let m;
    while ((m = listRe.exec(lower)) !== null) {
      if ((m[1].match(/\d{1,2}/g) ?? []).includes(sdgNum)) return true;
    }

    // keyword fallback
    const entry = Object.entries(SDG_KEYWORDS).find(([k]) => k.startsWith(`SDG${sdgNumber}_`));
    if (entry) {
      const kws = [...entry[1].elsevier, ...entry[1].auckland];
      if (kws.some(kw => new RegExp(`\\b${escapeRegex(kw.toLowerCase())}\\b`, 'i').test(lower))) return true;
    }
  }
  return false;
}

// ── Schema name filter (same logic as cs-indexer-hbar) ────────────────────────

function isProjectSchema(schemaName) {
  if (!schemaName) return false;
  if (schemaName.includes('Developer Application')) return false;
  return schemaName.startsWith('Project') || schemaName.startsWith('Parent: Project');
}

// ── credentialSubject extraction ───────────────────────────────────────────────

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

function str(v) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function isUsable(v) {
  if (!v || typeof v !== 'string') return false;
  const s = v.trim();
  return s && s !== 'Not specified' && s !== 'Not applicable' &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
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

function extractName(cs) {
  const pd = cs?.projectDescription, pdet = cs?.project_details;
  return str(cs?.name) ??
    (typeof pd === 'object' ? str(pd?.name) : null) ??
    str(cs?.projectTitle) ?? str(cs?.['Project title']) ??
    str(cs?.vcs_project_title) ?? str(cs?.projectName) ??
    str(cs?.title) ??
    (typeof pdet === 'object' ? str(pdet?.G5) : null) ??
    'N/A';
}

function extractDescription(cs) {
  const pd = cs?.projectDescription, pdet = cs?.project_details;
  const raw = str(cs?.summaryDescription) ??
    (typeof pd === 'object' ? str(pd?.G132) : null) ??
    (typeof pdet === 'object' ? str(pdet?.G132) : null) ??
    str(cs?.['Project Description']) ??
    str(cs?.vcs_project_description) ??
    str(cs?.description) ?? str(cs?.summary) ?? 'N/A';
  return raw !== 'N/A' && raw.length > 300 ? raw.slice(0, 300) + '...' : raw;
}

function extractType(cs) {
  if (cs?.category && isUsable(cs.category)) return str(cs.category);
  if (cs?.projectTypes) return Array.isArray(cs.projectTypes) ? cs.projectTypes.join(', ') : str(cs.projectTypes);
  if (cs?.projectType) {
    const raw = Array.isArray(cs.projectType) ? cs.projectType.join(', ') : str(cs.projectType);
    return raw ? parsePythonList(raw) : null;
  }
  const fromBlock = block => {
    if (typeof block !== 'object' || !block) return null;
    const vcsTypes = block?.registry_vcs?.vcs_additional_project_types;
    if (Array.isArray(vcsTypes)) { const u = vcsTypes.filter(isUsable); if (u.length) return u.join(', '); }
    const g143 = block?.G143;
    if (typeof g143 === 'object' && isUsable(g143?.G6)) return str(g143.G6);
    if (isUsable(block?.registry_ccb?.ccb_project_type)) return str(block.registry_ccb.ccb_project_type);
    return null;
  };
  return fromBlock(cs?.projectDescription) ?? fromBlock(cs?.project_details) ??
    str(cs?.project_type) ?? str(cs?.type_of_project) ?? str(cs?.scope) ?? null;
}

function parseSdgsFromString(s) {
  if (!s || typeof s !== 'string') return [];
  const matches = [...s.matchAll(/\b(1[0-7]|[1-9]) - /g)];
  const nums = [...new Set(matches.map(m => parseInt(m[1], 10)))].sort((a, b) => a - b);
  return nums.map(n => `SDG ${n} - ${SDG_MAP[`SDG ${n}`] ?? 'Goal ' + n}`);
}

function extractSdgs(cs) {
  if (cs?.SDGImpact) { const s = parseSdgsFromString(cs.SDGImpact); if (s.length) return s; }
  const raw = cs?.impactAndRiskSdgs;
  if (Array.isArray(raw) && raw.length) return raw;
  for (const block of [cs?.projectDescription, cs?.project_details]) {
    if (block && typeof block === 'object') {
      const n = block?.impactAndRiskSdgs;
      if (Array.isArray(n) && n.length) return n;
    }
  }
  return [];
}

function extractLocation(cs) {
  const loc = cs?.location;
  const locStr = typeof loc === 'string' ? str(loc) : null;
  return locStr ?? str(cs?.country) ?? str(cs?.projectCountry) ?? str(cs?.region) ?? str(cs?.['Project Country']) ?? null;
}

// ── textSearch fallback parser (for search-endpoint results without full VC JSON) ──

function parseFromTextSearch(textSearch) {
  if (!textSearch) return {};
  const parts = textSearch.split('|');
  const payload = parts.slice(12);

  let name = null;
  let nameIdx = -1;
  for (let i = 0; i < Math.min(payload.length, 8); i++) {
    const p = payload[i].trim();
    if (!p || p === '[object Object]') continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(p) || /^[0-9a-f]{8}-[0-9a-f]{4}/.test(p) || p.length < 4) continue;
    name = p.length > 150 ? p.slice(0, 150) : p;
    nameIdx = i;
    break;
  }

  let description = null;
  for (let i = nameIdx + 1; i < Math.min(payload.length, 12); i++) {
    const p = payload[i].trim();
    if (p.length > 80) { description = p.length > 300 ? p.slice(0, 300) + '...' : p; break; }
  }

  let projectType = null;
  for (let i = nameIdx + 1; i < Math.min(payload.length, 10); i++) {
    const p = payload[i].trim();
    if (p.length > 10 && p.length < 100 && !p.includes(' - ') && p !== description) { projectType = p; break; }
  }

  const sdgs = parseSdgsFromString(textSearch);

  const countryPattern = /^[A-Z][a-z]+(?:\s[A-Z][a-z]+)*$/;
  let location = null;
  for (const t of parts.slice(-8)) {
    const p = t.trim();
    if (p.length > 3 && p.length < 50 && countryPattern.test(p) && !['Project', 'VC-Document', 'ISSUE', 'NEW'].includes(p)) { location = p; break; }
  }

  return { name, description, projectType, sdgs, location };
}

// ── Formatter ──────────────────────────────────────────────────────────────────

// Always link to mainnet regardless of which indexer the API calls hit.
const INDEXER_BASE_URL = 'https://indexer.guardianservice.app/api/v1/mainnet';

function formatProject(item, index) {
  const hederaId  = item.consensusTimestamp ?? item.uuid ?? `item-${index}`;
  const analytics = item.analytics ?? {};

  let name, description, projectType, sdgs, location;
  const cs = extractCs(item);
  if (cs) {
    name        = extractName(cs);
    description = extractDescription(cs);
    projectType = extractType(cs);
    sdgs        = extractSdgs(cs);
    location    = extractLocation(cs);
  } else {
    const p  = parseFromTextSearch(analytics.textSearch ?? '');
    name        = p.name ?? 'N/A';
    description = p.description ?? null;
    projectType = p.projectType ?? null;
    sdgs        = p.sdgs ?? [];
    location    = p.location ?? null;

    // Additional fallback: try to get name/type from analytics.textSearch directly
    if (name === 'N/A' && analytics.textSearch) {
      const ts = analytics.textSearch;
      // Last pipe-segment before "Project" schema marker is often the project name
      const segments = ts.split('|');
      const projIdx = segments.lastIndexOf('Project');
      if (projIdx > 0) {
        const candidate = segments[projIdx - 1]?.trim();
        if (candidate && candidate.length > 4 && candidate.length < 200) name = candidate;
      }
    }
  }

  const sourceUrl = `/indexer/${encodeURIComponent(hederaId)}`;

  return [
    `${index + 1}. ${name}`,
    `   Hedera ID: ${hederaId}`,
    description && description !== 'N/A' ? `   Description: ${description}` : null,
    projectType ? `   Type: ${projectType}` : null,
    sdgs.length > 0 ? `   SDGs: ${sdgs.slice(0, 6).join(', ')}` : null,
    location ? `   Location: ${location}` : null,
    `   🔗 Indexer: [Verify on Guardian Mainnet](${sourceUrl})`,
  ].filter(Boolean).join('\n');
}

// ── sp_search_projects ────────────────────────────────────────────────────────

const SearchProjectsSchema = z.object({
  query: z.string().optional().describe(
    'Free-text keyword search, e.g. "biochar Uganda" or "solar micro-grid". ' +
    'Searched across the full VC text. Optional when sdg is provided.'
  ),
  sdg: z.number().int().min(1).max(17).optional().describe(
    'Filter by SDG number (1–17). Uses the full elsevier + auckland keyword list from the reference indexer.'
  ),
  pageSize: z.number().int().min(1).max(100).optional().describe('Max results to return (default 20).'),
});

class SearchProjectsTool extends BaseHederaQueryTool {
  name = 'sp_search_projects';
  description =
    'Search the live Hedera Guardian indexer for real nature-based carbon and sustainability projects. ' +
    'Pass sdg=13 to find all Climate Action projects. ' +
    'Returns real project names, types, SDG tags, and direct Guardian source links. ' +
    'Always call this before creating a campaign.';
  specificInputSchema = SearchProjectsSchema;
  namespace = 'sustainability-projects';

  #client;

  constructor(params) {
    super(params);
    this.#client = axios.create({
      baseURL: process.env.NATURE_BACKERS_API_URL,
      timeout: 25_000,
      headers: { Authorization: `Bearer ${process.env.NATURE_BACKERS_TOKEN}` },
    });
  }

  // Broad search terms that reliably surface project-schema VC-Documents from the Guardian indexer
  static #BROAD_QUERIES = [
    'carbon', 'reforestation', 'sequestration', 'renewable', 'conservation',
    'afforestation', 'forest', 'solar', 'emissions', 'biochar', 'wetland', 'deforestation',
  ];

  async #fetchAllProjects() {
    const seen = new Map();
    const add = (items) => {
      for (const item of (Array.isArray(items) ? items : [])) {
        const key = item.uuid || item.consensusTimestamp;
        if (key && !seen.has(key)) seen.set(key, item);
      }
    };
    await Promise.allSettled(
      SearchProjectsTool.#BROAD_QUERIES.map(q =>
        this.#client.get('/search', { params: { search: q, pageIndex: 0, pageSize: 100 } })
          .then(r => add(Array.isArray(r.data) ? r.data : r.data?.items))
      )
    );
    return [...seen.values()].filter(i => isProjectSchema(i?.analytics?.schemaName));
  }

  async executeQuery({ query, sdg, pageSize = 20 }) {
    this.logger.info(`SP search_projects query="${query}" sdg=${sdg}`);
    const seen = new Map();
    const add = (items) => {
      for (const item of (Array.isArray(items) ? items : [])) {
        const key = item.uuid || item.consensusTimestamp;
        if (key && !seen.has(key)) seen.set(key, item);
      }
    };

    if (sdg) {
      // Broad sweep to collect all project-schema items, then filter by SDG
      const allProjects = await this.#fetchAllProjects();
      add(allProjects);

      // Also try SDG-specific full-text and keyword searches
      const sdgCode      = `SDG ${sdg}`;
      const termKeywords = getSdgTermKeywords(sdg);
      await Promise.allSettled([
        this.#client.get('/search', { params: { search: sdgCode, pageIndex: 0, pageSize: 100 } })
          .then(r => add(Array.isArray(r.data) ? r.data : r.data?.items)),
        this.#client.get(`/entities/vc-documents?keywords=${encodeURIComponent(JSON.stringify(termKeywords))}`)
          .then(r => add(r.data?.items)),
      ]);
    } else if (query) {
      await Promise.allSettled([
        this.#client.get('/search', { params: { search: query, pageIndex: 0, pageSize: 100 } })
          .then(r => add(Array.isArray(r.data) ? r.data : r.data?.items)),
        this.#client.get(`/entities/vc-documents?keywords=${encodeURIComponent(JSON.stringify([query]))}`)
          .then(r => add(r.data?.items)),
      ]);
    } else {
      return 'Please provide a query or sdg number.';
    }

    // Filter to project-schema VC-Documents only
    let items = [...seen.values()].filter(i => isProjectSchema(i?.analytics?.schemaName));

    // Apply SDG filter using the rich keyword matcher from cs-indexer-hbar
    if (sdg) {
      items = items.filter(i => filterProjectBySDGs(i?.analytics?.textSearch ?? '', [sdg]));
    }

    if (items.length === 0) {
      return `No projects found on the Guardian indexer for ${sdg ? `SDG ${sdg}` : `"${query}"`}. The indexer may have limited coverage for this filter — try a broader keyword.`;
    }

    const shown = items.slice(0, pageSize);
    const lines = shown.map((p, i) => formatProject(p, i));
    return `Found ${items.length} project(s) on the Guardian indexer (showing ${shown.length}):\n\n${lines.join('\n\n')}`;
  }
}

// ── sp_get_project_detail ─────────────────────────────────────────────────────

const GetProjectDetailSchema = z.object({
  messageId: z.string().describe(
    'The consensusTimestamp of the project VC to retrieve, as returned by sp_search_projects.'
  ),
});

class GetProjectDetailTool extends BaseHederaQueryTool {
  name = 'sp_get_project_detail';
  description =
    'Retrieve the full VC document for a Guardian indexer project by its consensusTimestamp. ' +
    'Returns complete project details including name, description, type, SDGs, and a verified source link.';
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
    const resp = await this.#client.get(`/entities/vc-documents/${encodeURIComponent(messageId)}`);
    const doc  = resp.data;
    if (!doc) return `No project found with ID: ${messageId}`;

    const sourceUrl = `/indexer/${encodeURIComponent(messageId)}`;
    const cs = extractCs(doc);

    if (cs) {
      const sdgs = extractSdgs(cs);
      return [
        `Project ID: ${messageId}`,
        `Name: ${extractName(cs)}`,
        `Description: ${extractDescription(cs)}`,
        `Type: ${extractType(cs) ?? 'N/A'}`,
        sdgs.length > 0 ? `SDGs: ${sdgs.join(', ')}` : null,
        `Location: ${extractLocation(cs) ?? 'N/A'}`,
        `Source: ${sourceUrl}`,
      ].filter(Boolean).join('\n');
    }

    // textSearch fallback
    const analytics = doc?.item?.analytics ?? doc?.analytics ?? {};
    const p = parseFromTextSearch(analytics.textSearch ?? '');
    return [
      `Project ID: ${messageId}`,
      `Name: ${p.name ?? 'N/A'}`,
      p.description ? `Description: ${p.description}` : null,
      p.projectType ? `Type: ${p.projectType}` : null,
      p.sdgs?.length ? `SDGs: ${p.sdgs.join(', ')}` : null,
      p.location ? `Location: ${p.location}` : null,
      `Source: ${sourceUrl}`,
    ].filter(Boolean).join('\n');
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class HederaSustainabilityProjectPlugin extends BasePlugin {
  id      = 'hedera-sustainability-project-plugin';
  name    = 'Hedera Sustainability Project Plugin';
  description = 'Searches the live Hedera Guardian indexer for real nature-based sustainability projects';
  version = '5.0.0';
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
