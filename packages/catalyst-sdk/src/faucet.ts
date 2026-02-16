/**
 * Dev-only faucet integration for `catalyst-testnet`.
 *
 * IMPORTANT:
 * - This is NOT safe for production distribution.
 * - The faucet private key is deterministic and shared. Use only for local/dev builds.
 *
 * Reference: `catalyst-node-rust/docs/wallet-faucet-integration-catalyst-testnet.md`
 */

/** `0x` + `fa` repeated 32 times (32 bytes). */
export const CATALYST_TESTNET_DEV_FAUCET_PRIVKEY_HEX =
  "0x" + "fa".repeat(32) as `0x${string}`;

