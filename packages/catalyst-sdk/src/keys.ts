import { ristretto255 } from "@noble/curves/ed25519.js";
import { normalizeHex32, hexToBytes, bytesToHex } from "./hex.js";

const ORDER = ristretto255.Point.Fn.ORDER;

function leBytesToBigInt(bytes: Uint8Array): bigint {
  let x = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) x = (x << 8n) + BigInt(bytes[i]!);
  return x;
}

function bigIntTo32Le(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = x;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function privkeyHexToScalar(privkeyHex: string): bigint {
  const pk = hexToBytes(normalizeHex32(privkeyHex));
  const x = leBytesToBigInt(pk) % ORDER;
  return x;
}

export function pubkeyFromPrivkeyHex(privkeyHex: string): `0x${string}` {
  const x = privkeyHexToScalar(privkeyHex);
  const P = ristretto255.Point.BASE.multiply(x);
  const pub = P.toBytes(); // compressed ristretto, 32 bytes
  return bytesToHex(pub);
}

export function scalarToBytesLE(s: bigint): Uint8Array {
  const v = ((s % ORDER) + ORDER) % ORDER;
  return bigIntTo32Le(v);
}

