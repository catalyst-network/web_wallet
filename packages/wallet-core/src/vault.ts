import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { scrypt } from "@noble/hashes/scrypt.js";

export type VaultRecordV1 = {
  version: 1;
  kdf: {
    name: "scrypt";
    N: number;
    r: number;
    p: number;
    saltHex: string;
  };
  cipher: {
    name: "xchacha20-poly1305";
    nonceHex: string;
  };
  ciphertextHex: string;
};

function bytesToHex(bytes: Uint8Array): string {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
function hexToBytes(hex: string): Uint8Array {
  if (!hex.startsWith("0x")) throw new Error("Expected 0x hex");
  const h = hex.slice(2);
  if (h.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function deriveKeyScrypt(args: {
  password: string;
  salt: Uint8Array;
  N: number;
  r: number;
  p: number;
  dkLen: number;
}): Uint8Array {
  const pwBytes = new TextEncoder().encode(args.password);
  return scrypt(pwBytes, args.salt, { N: args.N, r: args.r, p: args.p, dkLen: args.dkLen });
}

export function createVaultV1(args: { password: string; plaintext: Uint8Array }): VaultRecordV1 {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(24));

  // MVP params: reasonable interactive target for browsers; adjust later / make configurable.
  const N = 1 << 15;
  const r = 8;
  const p = 1;

  const key = deriveKeyScrypt({ password: args.password, salt, N, r, p, dkLen: 32 });
  const aead = xchacha20poly1305(key, nonce);
  const ciphertext = aead.encrypt(args.plaintext);

  return {
    version: 1,
    kdf: { name: "scrypt", N, r, p, saltHex: bytesToHex(salt) },
    cipher: { name: "xchacha20-poly1305", nonceHex: bytesToHex(nonce) },
    ciphertextHex: bytesToHex(ciphertext),
  };
}

export function openVaultV1(args: { password: string; record: VaultRecordV1 }): Uint8Array {
  if (args.record.version !== 1) throw new Error("Unsupported vault version");
  if (args.record.kdf.name !== "scrypt") throw new Error("Unsupported KDF");
  if (args.record.cipher.name !== "xchacha20-poly1305") throw new Error("Unsupported cipher");

  const salt = hexToBytes(args.record.kdf.saltHex);
  const nonce = hexToBytes(args.record.cipher.nonceHex);
  const ciphertext = hexToBytes(args.record.ciphertextHex);
  const key = deriveKeyScrypt({
    password: args.password,
    salt,
    N: args.record.kdf.N,
    r: args.record.kdf.r,
    p: args.record.kdf.p,
    dkLen: 32,
  });
  const aead = xchacha20poly1305(key, nonce);
  return aead.decrypt(ciphertext);
}

