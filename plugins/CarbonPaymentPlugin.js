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
    'Look up a Hedera EVM smart contract transaction by its tx hash on the mirror node. ' +
    'Returns contract ID, from/to addresses, status, block, timestamps, gas, and event logs. ' +
    'Use to verify any on-chain contract interaction independently of the NatureBackers API.';
  specificInputSchema = GetContractResultSchema;
  namespace = 'carbon-payment';

  async executeQuery({ txHash }) {
    const network = (process.env.HEDERA_NETWORK || 'testnet').toLowerCase();
    const mirrorBase = network === 'mainnet'
      ? 'https://mainnet-public.mirrornode.hedera.com'
      : 'https://testnet.mirrornode.hedera.com';

    this.logger.info(`Hedera mirror node: contract result for ${txHash}`);
    const resp = await axios.get(`${mirrorBase}/api/v1/contracts/results/${txHash}`, { timeout: 15_000 });
    const r = resp.data;

    return [
      `Hedera Contract Transaction`,
      `Hash:      ${r.hash}`,
      `Contract:  ${r.contract_id}`,
      `From:      ${r.from}`,
      `To:        ${r.to}`,
      `Status:    ${r.result} (EVM status ${r.status})`,
      `Block:     ${r.block_number}`,
      `Timestamp: ${r.timestamp}`,
      `Gas used:  ${r.gas_used?.toLocaleString()} / ${r.gas_limit?.toLocaleString()}`,
      r.error_message ? `Error:     ${r.error_message}` : null,
      `Logs:      ${r.logs?.length ?? 0} event(s)`,
    ].filter(Boolean).join('\n');
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
