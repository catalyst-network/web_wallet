export type CatalystNetworkConfig = {
  networkId: string;
  chainId: bigint;
  genesisHashHex: `0x${string}`;
  /**
   * Default RPC endpoints (base URLs). Prefer HTTPS in production.
   * Order matters for failover: first is preferred, then fallbacks.
   */
  rpcUrls: string[];
};

export const CATALYST_TESTNET: CatalystNetworkConfig = {
  networkId: "catalyst-testnet",
  chainId: 200820092n,
  genesisHashHex:
    "0x32bceec02712a1184f788ce4aebf3472e98be2f09ffd5e356148e13a01f7ea9d",
  rpcUrls: [
    "https://testnet-eu-rpc.catalystnet.org",
    "https://testnet-us-rpc.catalystnet.org",
    "https://testnet-asia-rpc.catalystnet.org",
  ],
};

