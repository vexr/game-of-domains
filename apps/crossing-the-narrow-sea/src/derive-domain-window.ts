import { GraphQLClient, gql } from "graphql-request";
import fetch from "cross-fetch";

const endpoint =
  process.env.SUBQL_ENDPOINT ||
  "https://subql.blue.taurus.subspace.network/v1/graphql";
const client = new GraphQLClient(endpoint, { fetch });

const GET_CONSENSUS_HASH = gql`
  query GetConsensusHash($height: numeric!) {
    consensus_blocks(where: { height: { _eq: $height } }, limit: 1) {
      height
      hash
    }
  }
`;

const FIND_DOMAIN_BLOCK_FOR_CONSENSUS = gql`
  query FindDomainBlock($pattern: String!) {
    domain_auto_evm_blocks(
      where: {
        logs: {
          _and: [
            { log_kind: { id: { _eq: "PreRuntime" } } }
            { value: { _ilike: "%RGTR%" } }
            { value: { _ilike: $pattern } }
          ]
        }
      }
      limit: 1
      order_by: { height: asc }
    ) {
      height
      logs(limit: 5) {
        value
        log_kind {
          id
        }
      }
    }
  }
`;

const getConsensusHash = async (height: string | number) => {
  const res = await client.request<{
    consensus_blocks: Array<{ height: string; hash: string }>;
  }>(GET_CONSENSUS_HASH, { height: String(height) });
  const row = res.consensus_blocks?.[0];
  if (!row) throw new Error(`Consensus block not found for height ${height}`);
  return row.hash;
};

const findDomainHeightForConsensusHash = async (hash: string) => {
  const pattern = `%${hash}%`;
  const res = await client.request<{
    domain_auto_evm_blocks: Array<{ height: string }>;
  }>(FIND_DOMAIN_BLOCK_FOR_CONSENSUS, { pattern });
  const row = res.domain_auto_evm_blocks?.[0];
  if (!row)
    throw new Error(`No domain block found containing consensus hash ${hash}`);
  return row.height;
};

const main = async () => {
  const consensusStart = process.env.CONSENSUS_START_HEIGHT;
  const consensusEnd = process.env.CONSENSUS_END_HEIGHT;
  if (!consensusStart || !consensusEnd) {
    throw new Error(
      "CONSENSUS_START_HEIGHT and CONSENSUS_END_HEIGHT are required"
    );
  }

  const startHash = await getConsensusHash(consensusStart);
  const endHash = await getConsensusHash(consensusEnd);

  const domainStartHeight = await findDomainHeightForConsensusHash(startHash);
  const domainEndHeight = await findDomainHeightForConsensusHash(endHash);

  console.log(
    JSON.stringify(
      {
        endpoint,
        input: {
          consensusStart: Number(consensusStart),
          consensusEnd: Number(consensusEnd),
        },
        output: {
          domainStartHeight,
          domainEndHeight,
        },
      },
      null,
      2
    )
  );
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
