import 'dotenv/config';
import {
  Client,
  PrivateKey,
  TopicCreateTransaction
} from "@hashgraph/sdk";

const client = Client.forTestnet();

const privateKey = PrivateKey.fromStringED25519(
  process.env.HEDERA_PRIVATE_KEY
);

client.setOperator(
  process.env.HEDERA_ACCOUNT_ID,
  privateKey
);

async function main() {
  const tx = await new TopicCreateTransaction()
    .setTopicMemo("Cross-chain audit logs")
    .execute(client);

  const receipt = await tx.getReceipt(client);

  console.log("Topic ID:", receipt.topicId.toString());
}

main();