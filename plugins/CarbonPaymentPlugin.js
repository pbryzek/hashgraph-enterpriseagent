/**
 * CarbonPaymentPlugin — write tools for HBAR transfers and HCS audit trail
 *
 * Tools:
 *   transfer_hbar            → Transfer HBAR for carbon offset payments (enforced by policy)
 *   submit_hcs_message       → Write an immutable audit record to an HCS topic
 *   hedera_get_contract_result → Look up any EVM tx hash on the Hedera mirror node
 */

import { Client, PrivateKey, TransferTransaction, Hbar, TopicMessageSubmitTransaction } from '@hashgraph/sdk';
import axios from 'axios';
import { z } from 'zod';
import { BasePlugin, BaseHederaQueryTool } from 'hedera-agent-kit';

// ── ABI vote decoder (same logic as NatureBackersCampaignPlugin) ───────────────
function decodeVoteParams(functionParams) {
  if (!functionParams || functionParams.length < 10) return null;
  const data = (functionParams.startsWith('0x') ? functionParams.slice(2) : functionParams).slice(8);
  const uint256AtByte   = (byteOffset) => Number(BigInt('0x' + data.slice(byteOffset * 2, byteOffset * 2 + 64)));
  const stringAtOffset  = (byteOffset) => {
    const h = byteOffset * 2;
    const len = Number(BigInt('0x' + data.slice(h, h + 64)));
    return Buffer.from(data.slice(h + 64, h + 64 + len * 2), 'hex').toString('utf8');
  };
  try {
    const campaignKey = stringAtOffset(uint256AtByte(0));
    const deptId      = uint256AtByte(32);
    const voterEmail  = stringAtOffset(uint256AtByte(64));
    const rawJson     = stringAtOffset(uint256AtByte(128));
    let vote = null;
    try { vote = JSON.parse(rawJson); } catch { /* leave null */ }
    return { campaignKey, departmentId: deptId, voterEmail, vote };
  } catch { return null; }
}

function getHederaClient() {
  const network = (process.env.HEDERA_NETWORK || 'testnet').toLowerCase();
  const client = network === 'mainnet' ? Client.forMainnet() : Client.forTestnet();
  const rawKey = process.env.HEDERA_PRIVATE_KEY || '';
  const pk = rawKey.startsWith('0x')
    ? PrivateKey.fromStringECDSA(rawKey)
    : PrivateKey.fromString(rawKey);
  client.setOperator(process.env.HEDERA_ACCOUNT_ID, pk);
  return client;
}

// ── transfer_hbar ──────────────────────────────────────────────────────────────

const TransferHbarSchema = z.object({
  toAccountId: z.string().describe('Recipient Hedera account ID, e.g. "0.0.12345".'),
  amount: z
    .number()
    .min(0.000001)
    .describe('Amount of HBAR to transfer (not tinybars). Max 50 HBAR per transfer enforced by enterprise policy.'),
  memo: z
    .string()
    .describe('Required transaction memo — include carbon project ID or campaign name for audit trail.'),
});

class TransferHbarTool extends BaseHederaQueryTool {
  name = 'transfer_hbar';
  description =
    'Transfer HBAR from the operator account to another Hedera account. ' +
    'Use for carbon offset payments or campaign funding. ' +
    'A memo is required by enterprise policy. Maximum 50 HBAR per transfer.';
  specificInputSchema = TransferHbarSchema;
  namespace = 'carbon-payment';

  async executeQuery({ toAccountId, amount, memo }) {
    this.logger.info(`CarbonPayment: transfer ${amount} HBAR → ${toAccountId} memo="${memo}"`);

    const client = getHederaClient();
    try {
      const tinybars = Math.round(amount * 1e8);
      const tx = await new TransferTransaction()
        .addHbarTransfer(process.env.HEDERA_ACCOUNT_ID, Hbar.fromTinybars(-tinybars))
        .addHbarTransfer(toAccountId, Hbar.fromTinybars(tinybars))
        .setTransactionMemo(memo.slice(0, 100))
        .execute(client);

      const receipt = await tx.getReceipt(client);
      const txId = tx.transactionId.toString();

      return [
        'HBAR transfer successful!',
        `Transaction ID: ${txId}`,
        `From:   ${process.env.HEDERA_ACCOUNT_ID}`,
        `To:     ${toAccountId}`,
        `Amount: ${amount} HBAR`,
        `Memo:   ${memo}`,
        `Status: ${receipt.status.toString()}`,
      ].join('\n');
    } finally {
      client.close();
    }
  }
}

// ── submit_hcs_message ─────────────────────────────────────────────────────────

const SubmitHcsMessageSchema = z.object({
  message: z
    .string()
    .describe('Audit message to record on HCS. Include action, actor, and context.'),
  topicId: z
    .string()
    .optional()
    .describe('HCS topic ID to submit to. Defaults to AUDIT_HCS_TOPIC_ID env var if set.'),
});

class SubmitHcsMessageTool extends BaseHederaQueryTool {
  name = 'submit_hcs_message';
  description =
    'Submit an immutable audit message to a Hedera Consensus Service (HCS) topic. ' +
    'Use to record carbon credit actions, campaign approvals, or compliance events ' +
    'as a tamper-proof on-chain audit trail.';
  specificInputSchema = SubmitHcsMessageSchema;
  namespace = 'carbon-payment';

  async executeQuery({ message, topicId }) {
    const resolvedTopicId = topicId ?? process.env.AUDIT_HCS_TOPIC_ID;

    if (!resolvedTopicId) {
      // Graceful fallback — still useful for demos without a pre-created topic
      const timestamp = new Date().toISOString();
      this.logger.info(`CarbonPayment: HCS fallback log [${timestamp}] ${message}`);
      return [
        'Audit message logged (local fallback — set AUDIT_HCS_TOPIC_ID to write on-chain):',
        `Timestamp: ${timestamp}`,
        `Message:   ${message}`,
      ].join('\n');
    }

    this.logger.info(`CarbonPayment: submit HCS audit → topic ${resolvedTopicId}`);
    const client = getHederaClient();
    try {
      const tx = await new TopicMessageSubmitTransaction()
        .setTopicId(resolvedTopicId)
        .setMessage(message)
        .execute(client);

      const receipt = await tx.getReceipt(client);
      const txId = tx.transactionId.toString();

      return [
        'HCS audit message recorded on-chain!',
        `Transaction ID: ${txId}`,
        `Topic:   ${resolvedTopicId}`,
        `Status:  ${receipt.status.toString()}`,
        `Message: ${message}`,
      ].join('\n');
    } finally {
      client.close();
    }
  }
}

// ── hedera_get_contract_result ─────────────────────────────────────────────────

const GetContractResultSchema = z.object({
  txHash: z
    .string()
    .describe('EVM transaction hash (0x...) to look up on the Hedera mirror node.'),
});

class GetContractResultTool extends BaseHederaQueryTool {
  name = 'hedera_get_contract_result';
  description =
    'ALWAYS call this tool when the user provides a 0x... transaction hash and asks to look it up, ' +
    'query it, fetch details, or check it on Hedera / Hashgraph. ' +
    'Do NOT generate an answer from memory — always call this tool. ' +
    'Automatically tries both Hedera testnet and mainnet mirror nodes. ' +
    'Returns contract ID, from/to addresses, status, block, consensus timestamp, gas, ' +
    'decoded ABI vote parameters (voter name, project, reason), state changes, and event logs. ' +
    'Also provides a direct Hashscan explorer link.';
  specificInputSchema = GetContractResultSchema;
  namespace = 'carbon-payment';

  async executeQuery({ txHash }) {
    const normalizedHash = txHash.startsWith('0x') ? txHash : `0x${txHash}`;

    const MIRRORS = [
      { label: 'testnet', base: 'https://testnet.mirrornode.hedera.com' },
      { label: 'mainnet', base: 'https://mainnet-public.mirrornode.hedera.com' },
    ];
    const configured = (process.env.HEDERA_NETWORK || 'testnet').toLowerCase();
    if (configured === 'mainnet') MIRRORS.reverse();

    for (const { label, base } of MIRRORS) {
      this.logger.info(`Hedera mirror node (${label}): contracts/results/${normalizedHash}`);

      let r;
      try {
        const resp = await axios.get(
          `${base}/api/v1/contracts/results/${normalizedHash}`,
          { timeout: 20_000 }
        );
        // 404 comes back as a 200 with _status.messages — treat as not found
        if (resp.data?._status) continue;
        r = resp.data;
      } catch (err) {
        // axios throws on 4xx/5xx; treat 404 as not found, re-throw anything else
        if (err?.response?.status === 404) continue;
        throw err;
      }

      if (!r) continue;

      // ── Decode ABI vote params if present ─────────────────────────────────
      const decoded = decodeVoteParams(r.function_parameters);
      const vote    = decoded?.vote;

      const lines = [
        `Hedera EVM Contract Transaction (${label})`,
        ``,
        `── Transaction ──`,
        `Hash:            ${r.hash}`,
        `Transaction ID:  ${r.transaction_id ?? '(none)'}`,
        `Block:           ${r.block_number}  (block hash: ${r.block_hash?.slice(0, 20) ?? '?'}…)`,
        `Consensus time:  ${r.timestamp}`,
        `Status:          ${r.result}`,
        ``,
        `── Contract ──`,
        `Contract ID:     ${r.contract_id}`,
        `From:            ${r.from}`,
        `To:              ${r.to}`,
        `Gas used:        ${r.gas_consumed?.toLocaleString() ?? r.gas_used?.toLocaleString()} / ${r.gas_limit?.toLocaleString()}`,
        r.error_message ? `Error:           ${r.error_message}` : null,
        `Logs:            ${r.logs?.length ?? 0} event(s)`,
        r.logs?.length > 0 ? r.logs.map((l, i) =>
          `  Log ${i}: ${l.topics?.length ?? 0} topic(s)  data: ${l.data?.slice(0, 40) ?? ''}…`
        ).join('\n') : null,
      ];

      if (vote) {
        lines.push(
          ``,
          `── Decoded Vote (ABI) ──`,
          `Campaign key:    ${decoded.campaignKey}`,
          `Vote ID:         ${vote.voteId}`,
          `Voter:           ${vote.userName} (user ID ${vote.userId})`,
          decoded.voterEmail ? `Voter email:     ${decoded.voterEmail}` : null,
          `Project voted:   ${vote.projectName} (project ID ${vote.projectId})`,
          `Department:      ${decoded.departmentId}`,
          `Reason:          ${vote.reason || '(none)'}`,
          `Recorded at:     ${vote.createdAt}`,
        );
      } else if (r.function_parameters && r.function_parameters.length > 10) {
        lines.push(``, `Function params: ${r.function_parameters.slice(0, 120)}…`);
      }

      lines.push(
        ``,
        `── State Changes ──`,
        (r.state_changes?.length > 0)
          ? r.state_changes.slice(0, 3).map(s =>
              `  slot ${s.slot?.slice(-8)} → ${s.value_written?.slice(-16)}`
            ).join('\n') + (r.state_changes.length > 3 ? `\n  …and ${r.state_changes.length - 3} more` : '')
          : '  (none)',
        ``,
        `🔗 View on Hashscan: https://hashscan.io/${label}/transaction/${normalizedHash}`,
      );

      return lines.filter(l => l != null).join('\n');
    }

    // Not found on either network
    return [
      `Transaction ${normalizedHash} was not found on Hedera testnet or mainnet.`,
      ``,
      `Possible reasons:`,
      `  • Mirror node propagation delay — new transactions take a few seconds to index. Retry in ~10s.`,
      `  • The hash is from a different blockchain (Ethereum, Polygon, etc.)`,
      `  • The hash is invalid or malformed (must be 32 bytes / 64 hex chars)`,
      ``,
      `Check directly on Hashscan:`,
      `  Testnet: https://hashscan.io/testnet/transaction/${normalizedHash}`,
      `  Mainnet: https://hashscan.io/mainnet/transaction/${normalizedHash}`,
    ].join('\n');
  }
}

// ── Plugin ─────────────────────────────────────────────────────────────────────

export class CarbonPaymentPlugin extends BasePlugin {
  id          = 'carbon-payment-plugin';
  name        = 'Carbon Payment Plugin';
  description = 'Write tools: HBAR carbon offset payments and HCS audit trail submissions';
  version     = '1.0.0';
  author      = 'CarbonSustain';

  #tools = [];

  async initialize(context) {
    await super.initialize(context);
    this.#tools = [
      new TransferHbarTool({ hederaKit: context.config.hederaKit, logger: context.logger }),
      new SubmitHcsMessageTool({ hederaKit: context.config.hederaKit, logger: context.logger }),
      new GetContractResultTool({ hederaKit: context.config.hederaKit, logger: context.logger }),
    ];
  }

  getTools() { return this.#tools; }
}
