import { blake2b } from "@noble/hashes/blake2.js";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english.js";

import { bytesToHex, concatBytes } from "@catalyst/catalyst-sdk";
import { pubkeyFromPrivkeyHex } from "@catalyst/catalyst-sdk";

const DST_MASTER = new TextEncoder().encode("CATALYST_WALLET_V1_MASTER");
const DST_ACCOUNT = new TextEncoder().encode("CATALYST_WALLET_V1_ACCOUNT");

function u32le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error("account_index must be u32");
  const out = new Uint8Array(4);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(0, n >>> 0, true);
  return out;
}

function h512(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 64 });
}

export type MnemonicStrength = 128 | 256; // 12 words | 24 words

export function createMnemonic(strength: MnemonicStrength = 128): string {
  return generateMnemonic(englishWordlist, strength);
}

export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, englishWordlist);
}

export function mnemonicToSeed(mnemonic: string, passphrase = ""): Uint8Array {
  if (!isValidMnemonic(mnemonic)) throw new Error("Invalid BIP39 mnemonic");
  // BIP39 seed is 64 bytes.
  return mnemonicToSeedSync(mnemonic, passphrase);
}

export function deriveMasterKeyMaterialV1(seed64: Uint8Array): Uint8Array {
  if (seed64.length !== 64) throw new Error("seed must be 64 bytes");
  return h512(concatBytes(DST_MASTER, seed64));
}

export function deriveAccountPrivkeyHexV1(args: {
  seed64: Uint8Array;
  accountIndex: number;
}): `0x${string}` {
  const master = deriveMasterKeyMaterialV1(args.seed64);
  const ikm = h512(concatBytes(DST_ACCOUNT, master, u32le(args.accountIndex)));
  const priv = ikm.slice(0, 32);
  return bytesToHex(priv);
}

export function deriveAccountAddressHexV1(args: {
  seed64: Uint8Array;
  accountIndex: number;
}): `0x${string}` {
  const privHex = deriveAccountPrivkeyHexV1(args);
  return pubkeyFromPrivkeyHex(privHex);
}

