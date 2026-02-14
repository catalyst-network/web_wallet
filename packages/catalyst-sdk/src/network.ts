export type CatalystNetworkConfig = {
  networkId: string;
  chainId: bigint;
  genesisHashHex: `0x${string}`;
  rpcUrl: string;
};

export const CATALYST_TESTNET: CatalystNetworkConfig = {
  networkId: "catalyst-testnet",
  chainId: 200820092n,
  genesisHashHex:
    "0xeea16848e6b1d39d6b7a5e094ad9189d5382a6a4b19fb95342ef9846258fee5a",
  rpcUrl: "http://45.32.177.248:8545",
};

