const main = async (): Promise<void> => {
  const endpoint =
    process.env.SUBQL_ENDPOINT ||
    "https://subql.blue.taurus.subspace.network/v1/graphql";
  console.log("[crossing-the-narrow-sea] Ready. Endpoint:", endpoint);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
