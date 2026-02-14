import { normalizeHex32 } from "@catalyst/catalyst-sdk";

export type WalletAccountV1 = {
  // 32-byte compressed Ristretto pubkey (Catalyst address)
  addressHex: `0x${string}`;
  label?: string;
};

export type WalletDataV1 = {
  version: 1;
  // MVP: single account, single raw private key (32 bytes hex)
  privateKeyHex: `0x${string}`;
  account: WalletAccountV1;
};

export function validatePrivateKeyHex(hex: string): `0x${string}` {
  return normalizeHex32(hex);
}

