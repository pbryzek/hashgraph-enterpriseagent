/**
 * DonateCampaignPlugin — fan donation tools with cross-chain audit
 *
 * Tools:
 *   donate_hbar_to_campaign  → TransferTransaction on Hedera + cross-chain audit
 *   donate_clpr_to_campaign  → CLPR payment record + cross-chain audit
 *
 * Each campaign carries two recipient addresses:
 *   hbarAddress  — Hedera account ID (e.g. "0.0.12345")
 *   clprAddress  — CLPR wallet address (e.g. "clpr:0xabc...")
 *
 * The agent always asks the user which chain they want to donate on before
 * calling either tool. Both tools record a cross-chain audit after execution.
 */

import { Client, PrivateKey, TransferTransaction, Hbar } from '@hashgraph/sdk';
import { z } from 'zod';
import { BasePlugin, BaseHederaQueryTool } from 'hedera-agent-kit';
import { recordCrossChainAudit } from './crossChainAudit.js';


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

// ── donate_hbar_to_campaign ───────────────────────────────────────────────────

const DonateHbarSchema = z.object({
  campaignId: z
    .number().int().min(1)
    .describe('Numeric Nature Backers campaign ID.'),
  campaignName: z
    .string().optional().default('Campaign')
    .describe('Human-readable campaign name — used in the memo. Fetch via nb_get_campaign if unknown.'),
  hbarAddress: z
    .string().optional().default('0.0.5490832')
    .describe('Recipient Hedera account ID. Always use 0.0.5490832 (admin wallet) unless told otherwise.'),
  amount: z
    .number().min(0.000001)
    .describe('Amount of HBAR to donate. Max 50 HBAR per transfer (enterprise policy).'),
  donorId: z
    .string().optional()
    .describe('Donor identifier (account ID, email, or display name) for the audit trail.'),
});

class DonateHbarTool extends BaseHederaQueryTool {
  name = 'donate_hbar_to_campaign';
  description =
    'Donate HBAR to a Nature Backers campaign. ' +
    'Transfers HBAR to the campaign\'s Hedera address, then records a cross-chain audit ' +
    'on both HCS and CLPR. Call this after the user confirms they want to donate via HBAR. ' +
    'Max 50 HBAR per transfer (enterprise policy). Always confirm amount and address with the user first.';
  specificInputSchema = DonateHbarSchema;
  namespace = 'donate-campaign';

  async executeQuery({ campaignId, campaignName, hbarAddress, amount }) {
    this.logger.info(`Donate HBAR: requesting ${amount} HBAR → campaign ${campaignId} (${hbarAddress}) via user wallet`);

    const memo = `NatureBackers campaign ${campaignId} donation`.slice(0, 100);

    // Fire-and-forget HCS audit for the donation intent so it appears in nb_get_hcs_records
    recordCrossChainAudit({
      eventType: 'DONATION_HBAR_INTENT',
      entityId:  `campaign-${campaignId}`,
      actor:     'user-wallet',
      payload: {
        campaignId,
        campaignName,
        toAccount: hbarAddress,
        amount,
        memo,
        timestamp: new Date().toISOString(),
      },
      tags: ['hbar-intent', `campaign-${campaignId}`, 'donation'],
    }).catch(err => this.logger.warn(`HBAR intent HCS audit failed: ${err.message}`));

    // Return a HashPack payment request — the frontend will prompt the user
    // to sign the transfer from their connected wallet (not the backend account).
    return JSON.stringify({
      __type:       'hashpack_payment_request',
      campaignId,
      campaignName,
      toAccount:    hbarAddress,
      amount,
      memo,
    });
  }
}

// ── donate_usdc_to_campaign ───────────────────────────────────────────────────

const DonateUsdcSchema = z.object({
  campaignId: z
    .number().int().min(1)
    .describe('Numeric Nature Backers campaign ID.'),
  campaignName: z
    .string().optional().default('Campaign')
    .describe('Human-readable campaign name — fetch via nb_get_campaign if unknown.'),
  usdcAddress: z
    .string().optional().default('0.0.5490832')
    .describe('Recipient Hedera account ID for USDC. Always use 0.0.5490832 (admin wallet) unless told otherwise.'),
  amount: z
    .number().min(0.000001)
    .describe('Amount of USDC to donate (e.g. 1.5 for $1.50).'),
  donorId: z
    .string().optional()
    .describe('Donor identifier for the audit trail.'),
});

class DonateUsdcTool extends BaseHederaQueryTool {
  name = 'donate_usdc_to_campaign';
  description =
    'Donate USDC stablecoin to a Nature Backers campaign via HashPack. ' +
    'Token ID on testnet is 0.0.456858. The user must have already associated that token ' +
    'in their HashPack wallet (get test USDC from https://faucet.circle.com/). ' +
    'Call this after the user confirms they want to donate via USDC. ' +
    'Always confirm amount and address with the user first.';
  specificInputSchema = DonateUsdcSchema;
  namespace = 'donate-campaign';

  async executeQuery({ campaignId, campaignName, usdcAddress, amount }) {
    this.logger.info(`Donate USDC: requesting ${amount} USDC → campaign ${campaignId} (${usdcAddress}) via user wallet`);

    const memo = `NatureBackers campaign ${campaignId} USDC donation`.slice(0, 100);

    recordCrossChainAudit({
      eventType: 'DONATION_USDC_INTENT',
      entityId:  `campaign-${campaignId}`,
      actor:     'user-wallet',
      payload: {
        campaignId,
        campaignName,
        toAccount: usdcAddress,
        amount,
        currency: 'USDC',
        tokenId:  '0.0.456858',
        memo,
        timestamp: new Date().toISOString(),
      },
      tags: ['usdc-intent', `campaign-${campaignId}`, 'donation'],
    }).catch(err => this.logger.warn(`USDC intent HCS audit failed: ${err.message}`));

    return JSON.stringify({
      __type:       'hashpack_usdc_payment_request',
      campaignId,
      campaignName,
      toAccount:    usdcAddress,
      amount,
      memo,
    });
  }
}

// ── donate_clpr_to_campaign ───────────────────────────────────────────────────

const DonateCLPRSchema = z.object({
  campaignId: z
    .number().int().min(1)
    .describe('Numeric Nature Backers campaign ID.'),
  campaignName: z
    .string()
    .describe('Human-readable campaign name — used in the audit record.'),
  clprAddress: z
    .string()
    .describe('Recipient CLPR wallet address for this campaign, e.g. "clpr:0xabc...".'),
  amount: z
    .number().min(0.01)
    .describe('Donation amount in CLPR units.'),
  currency: z
    .string().optional().default('CLPR')
    .describe('Currency label (default "CLPR").'),
  donorId: z
    .string().optional()
    .describe('Donor identifier for the audit trail.'),
});

class DonateCLPRTool extends BaseHederaQueryTool {
  name = 'donate_clpr_to_campaign';
  description =
    'Donate via CLPR (Cross-Ledger Payment Record) to a Nature Backers campaign. ' +
    'Submits a CLPR payment record to the campaign\'s CLPR address, then records a cross-chain audit ' +
    'on both HCS and CLPR. Call this after the user confirms they want to donate via CLPR. ' +
    'In simulation mode (no CLPR_API_KEY) a deterministic proof hash is returned for demo purposes.';
  specificInputSchema = DonateCLPRSchema;
  namespace = 'donate-campaign';

  async executeQuery({ campaignId, campaignName, clprAddress, amount, currency = 'CLPR', donorId }) {
    this.logger.info(`Donate CLPR: ${amount} ${currency} → campaign ${campaignId} (${clprAddress})`);

    const simulate = process.env.CLPR_SIMULATE === 'true' || !process.env.CLPR_API_KEY;
    let clprTxHash, clprProofHash;

    if (simulate) {
      const { createHash } = await import('crypto');
      const base      = JSON.stringify({ campaignId, clprAddress, amount, currency, ts: Date.now() });
      clprTxHash  = '0xclpr_donate_' + createHash('sha256').update(base).digest('hex').slice(0, 40);
      clprProofHash = createHash('sha256').update(base + '_proof').digest('hex');
    } else {
      const { default: axios } = await import('axios');
      const resp = await axios.post(
        `${process.env.CLPR_ENDPOINT_URL}/payments`,
        {
          recipient: clprAddress,
          amount,
          currency,
          memo: `NatureBackers campaign ${campaignId} donation`,
          metadata: { campaignId, campaignName },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.CLPR_API_KEY}`,
          },
          timeout: 15_000,
        }
      );
      clprTxHash    = resp.data?.tx_hash   ?? resp.data?.transactionHash;
      clprProofHash = resp.data?.proofHash ?? '';
    }

    // ── Cross-chain audit ─────────────────────────────────────────────────────
    const audit = await recordCrossChainAudit({
      eventType: 'DONATION_CLPR',
      entityId:  `campaign-${campaignId}`,
      actor:     donorId ?? 'unknown',
      payload: {
        campaignId,
        campaignName,
        currency,
        amount,
        clprAddress,
        clprTxHash,
        clprProofHash,
        simulated: simulate,
        timestamp: new Date().toISOString(),
      },
      tags: ['clpr', `campaign-${campaignId}`, 'donation'],
    });

    const { hcs, clpr, summary } = audit;

    return [
      `CLPR Donation ${simulate ? '(Simulated) ' : ''}Successful!`,
      ``,
      `── CLPR Payment ──`,
      `CLPR tx_hash:   ${clprTxHash}`,
      `Proof hash:     ${clprProofHash}`,
      `To:             ${clprAddress}  (${campaignName})`,
      `Amount:         ${amount} ${currency}`,
      simulate ? `Mode:           Simulation (set CLPR_API_KEY to go live)` : null,
      ``,
      `── Cross-Chain Audit (${summary.status.toUpperCase()}) ──`,
      `Audit ID:       ${summary.auditId}`,
      `Integrity hash: ${summary.integrityHash}`,
      hcs.error
        ? `HCS:  FAILED — ${hcs.error}`
        : `HCS:  ${hcs.tx_hash}  seq#=${hcs.sequenceNumber}${hcs.simulated ? '  (simulated)' : ''}`,
      clpr.error
        ? `CLPR Audit: FAILED — ${clpr.error}`
        : `CLPR Audit: ${clpr.tx_hash}${clpr.simulated ? '  (simulated)' : ''}`,
    ].filter(Boolean).join('\n');
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class DonateCampaignPlugin extends BasePlugin {
  id      = 'donate-campaign-plugin';
  name    = 'Donate Campaign Plugin';
  description =
    'Fan donation tools for Nature Backers campaigns — supports HBAR and CLPR payment paths, ' +
    'each with automatic cross-chain audit recording on HCS and CLPR';
  version = '1.0.0';
  author  = 'CarbonSustain';

  #tools = [];

  async initialize(context) {
    await super.initialize(context);
    this.#tools = [
      new DonateHbarTool({ hederaKit: context.config.hederaKit, logger: context.logger }),
      new DonateUsdcTool({ hederaKit: context.config.hederaKit, logger: context.logger }),
      new DonateCLPRTool({ hederaKit: context.config.hederaKit, logger: context.logger }),
    ];
  }

  getTools() { return this.#tools; }
}
