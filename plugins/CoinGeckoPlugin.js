/**
 * CoinCapPlugin — fetches live HBAR price data from the CoinCap v2 API.
 *
 * Tool: get_hbar_price → GET https://api.coincap.io/v2/assets/hedera-hashgraph
 */

import axios from 'axios';
import { z } from 'zod';
import { BasePlugin, BaseHederaQueryTool } from 'hedera-agent-kit';

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price' +
  '?ids=hedera-hashgraph&vs_currencies=usd' +
  '&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true';

const GetHbarPriceSchema = z.object({});

class GetHbarPriceTool extends BaseHederaQueryTool {
  name = 'get_hbar_price';
  description =
    'Fetch the current live price of HBAR (Hedera Hashgraph) in USD, ' +
    'along with 24-hour change, market cap, and volume. ' +
    'Use when the user asks about HBAR price, value, or market data.';
  specificInputSchema = GetHbarPriceSchema;
  namespace = 'coincap';

  async executeQuery() {
    this.logger.info('CoinGecko: fetching HBAR price');

    const resp = await axios.get(COINGECKO_URL, { timeout: 10_000 });
    const d = resp.data?.['hedera-hashgraph'];

    if (!d) return 'Could not retrieve HBAR price data at this time.';

    const price     = d.usd.toFixed(6);
    const change24h = (d.usd_24h_change ?? 0).toFixed(2);
    const marketCap = ((d.usd_market_cap ?? 0) / 1e9).toFixed(2);
    const volume24h = ((d.usd_24h_vol ?? 0) / 1e6).toFixed(2);
    const direction = parseFloat(change24h) >= 0 ? 'up ▲' : 'down ▼';

    return (
      `HBAR (Hedera Hashgraph) — Live Price\n` +
      `Price:      $${price} USD\n` +
      `24h Change: ${change24h}% (${direction})\n` +
      `Market Cap: $${marketCap}B USD\n` +
      `24h Volume: $${volume24h}M USD`
    );
  }
}

export class CoinCapPlugin extends BasePlugin {
  id      = 'coincap-plugin';
  name    = 'CoinCap Plugin';
  description = 'Provides live HBAR price and market data via the CoinCap API';
  version = '1.0.0';
  author  = 'CarbonSustain';

  #tools = [];

  async initialize(context) {
    await super.initialize(context);
    this.#tools = [
      new GetHbarPriceTool({ hederaKit: context.config.hederaKit, logger: context.logger }),
    ];
  }

  getTools() {
    return this.#tools;
  }
}
