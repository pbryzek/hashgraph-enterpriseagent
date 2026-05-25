/**
 * NatureBackersPlugin — Hedera Agent Kit plugin that searches the NatureBackers
 * environmental project registry.
 *
 * Extends BasePlugin (hedera-agent-kit) so it integrates cleanly with
 * HederaAgentKit.initialize() and getAggregatedLangChainTools().
 *
 * Tool: search_nature_projects  →  GET /search?search={query}
 */

import axios from 'axios';
import { z } from 'zod';
import { BasePlugin } from 'hedera-agent-kit';
import { BaseHederaQueryTool } from 'hedera-agent-kit';

// ── Zod schema ────────────────────────────────────────────────────────────────

const SearchSchema = z.object({
  query: z
    .string()
    .describe(
      'Full-text search query sent to the NatureBackers registry. ' +
      'Examples: "water sustainability Kenya", "SDG 6", "reforestation Brazil".'
    ),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe('Number of results to return (default 10, max 50)'),
  pageIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe('Pagination offset (default 0)'),
});

// ── Tool ──────────────────────────────────────────────────────────────────────

class SearchNatureProjectsTool extends BaseHederaQueryTool {
  name = 'search_nature_projects';
  description =
    'Search the NatureBackers registry for nature-based carbon and sustainability projects. ' +
    'Returns project metadata including title, SDGs, policy, and registry info. ' +
    'Use this whenever the user asks about projects, campaigns, water sustainability, ' +
    'reforestation, carbon credits, or any environmental initiative.';
  specificInputSchema = SearchSchema;
  namespace = 'nature-backers';

  #client;

  constructor(params) {
    super(params);
    this.#client = axios.create({
      baseURL: process.env.NATURE_BACKERS_API_URL,
      timeout: 15_000,
      headers: {
        Authorization: `Bearer ${process.env.NATURE_BACKERS_TOKEN}`,
      },
    });
  }

  async executeQuery({ query, pageSize = 10, pageIndex = 0 }) {
    this.logger.info(`NatureBackers search: "${query}" (page ${pageIndex}, size ${pageSize})`);

    const resp = await this.#client.get('/search', {
      params: { search: query, pageIndex, pageSize },
    });

    const data = resp.data;
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    const total = Array.isArray(data) ? items.length : (data?.total ?? items.length);

    if (items.length === 0) {
      return `No projects found for query: "${query}"`;
    }

    const lines = items.map((p, i) => {
      const text  = p?.analytics?.textSearch?.slice(0, 120) || p?.options?.issuer || p?.uuid || `Project ${i + 1}`;
      const schema = p?.analytics?.schemaName || '';
      const policy = p?.analytics?.policyId   || '';
      const ts     = p?.consensusTimestamp    || '';
      const meta   = [schema, policy && `policy:${policy}`, ts && `ts:${ts}`].filter(Boolean).join(' | ');
      return `${i + 1}. ${text}${meta ? `  [${meta}]` : ''}`;
    });

    return `Found ${total} result(s) (showing ${items.length}):\n${lines.join('\n')}`;
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class NatureBackersPlugin extends BasePlugin {
  id      = 'nature-backers-plugin';
  name    = 'NatureBackers Plugin';
  description = 'Searches the NatureBackers environmental project registry via its REST API';
  version = '1.0.0';
  author  = 'CarbonSustain';

  #tools = [];

  async initialize(context) {
    await super.initialize(context);
    this.#tools = [
      new SearchNatureProjectsTool({
        hederaKit: context.config.hederaKit,
        logger:    context.logger,
      }),
    ];
  }

  getTools() {
    return this.#tools;
  }
}
