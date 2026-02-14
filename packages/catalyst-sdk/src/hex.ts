export function assert0x(hex: string): asserts hex is `0x${string}` {
  if (!hex.startsWith("0x")) throw new Error("Expected 0x-prefixed hex");
}

export function hexToBytes(hex: `0x${string}`): Uint8Array {
  const h = hex.slice(2);
  if (h.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = h.slice(i * 2, i * 2 + 2);
    const v = Number.parseInt(byte, 16);
    if (!Number.isFinite(v)) throw new Error("Invalid hex");
    out[i] = v;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s as `0x${string}`;
}

export function normalizeHex32(hex: string): `0x${string}` {
  if (!hex.startsWith("0x")) throw new Error("Expected 0x-prefixed hex");
  const h = hex.slice(2).toLowerCase();
  if (!/^[0-9a-f]+$/.test(h)) throw new Error("Invalid hex");
  if (h.length !== 64) throw new Error("Expected 32-byte hex (64 chars)");
  return (`0x${h}`) as `0x${string}`;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

