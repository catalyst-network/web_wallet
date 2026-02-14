import { concatBytes } from "./hex.js";

export function u8(v: number): Uint8Array {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new Error("u8 out of range");
  return Uint8Array.of(v);
}

export function u32le(v: number): Uint8Array {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error("u32 out of range");
  const out = new Uint8Array(4);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(0, v >>> 0, true);
  return out;
}

export function u64le(v: bigint): Uint8Array {
  if (v < 0n || v > 0xffffffffffffffffn) throw new Error("u64 out of range");
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export function i64le(v: bigint): Uint8Array {
  if (v < -(1n << 63n) || v > (1n << 63n) - 1n) throw new Error("i64 out of range");
  // two's complement into unsigned 64-bit
  const u = v < 0n ? (1n << 64n) + v : v;
  return u64le(u);
}

export function vec(items: Uint8Array[]): Uint8Array {
  return concatBytes(u32le(items.length), ...items);
}

export function bytesVec(bytes: Uint8Array): Uint8Array {
  return concatBytes(u32le(bytes.length), bytes);
}

