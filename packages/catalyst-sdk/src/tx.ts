import { blake2b } from "@noble/hashes/blake2.js";
import { ristretto255 } from "@noble/curves/ed25519.js";
import { bytesToHex, concatBytes, hexToBytes, normalizeHex32 } from "./hex.js";
import { bytesVec, i64le, u32le, u64le, u8, vec } from "./encoding.js";
import { privkeyHexToScalar, scalarToBytesLE, pubkeyFromPrivkeyHex } from "./keys.js";

export type TransactionType = "NonConfidentialTransfer";

export type NonConfidentialEntry = {
  publicKeyHex: `0x${string}`; // 32-byte compressed ristretto pubkey
  amount: bigint; // i64
};

export type TransactionCore = {
  txType: TransactionType;
  entries: NonConfidentialEntry[];
  nonce: bigint; // u64
  lockTime: number; // u32
  fees: bigint; // u64
  data: Uint8Array; // <= 60 bytes recommended
};

export type Transaction = {
  core: TransactionCore;
  signature: Uint8Array; // 64 bytes
  timestamp: bigint; // u64 ms
};

const TX_WIRE_MAGIC_V1 = new TextEncoder().encode("CTX1");
const TX_SIG_DOMAIN_V1 = new TextEncoder().encode("CATALYST_SIG_V1");
const TX_WIRE_MAGIC_V2 = new TextEncoder().encode("CTX2");
const TX_SIG_DOMAIN_V2 = new TextEncoder().encode("CATALYST_SIG_V2");

export type TransactionV2 = {
  core: TransactionCore;
  signatureScheme: number; // u8 (currently only 0 supported)
  signature: Uint8Array; // 64 bytes (Schnorr)
  senderPubkey: null | Uint8Array; // Option<Vec<u8>>; must be null for now
  timestamp: bigint; // u64 ms
};

function txTypeTag(t: TransactionType): number {
  switch (t) {
    case "NonConfidentialTransfer":
      return 0;
  }
}

function serializeEntryAmountNonConfidential(amount: bigint): Uint8Array {
  // tag 0x00 + i64 le
  return concatBytes(u8(0), i64le(amount));
}

function serializeEntry(e: NonConfidentialEntry): Uint8Array {
  const pk = hexToBytes(normalizeHex32(e.publicKeyHex));
  if (pk.length !== 32) throw new Error("public key must be 32 bytes");
  return concatBytes(pk, serializeEntryAmountNonConfidential(e.amount));
}

export function serializeCoreV1(core: TransactionCore): Uint8Array {
  if (core.data.length > 60) throw new Error("core.data must be <= 60 bytes");
  const entriesBytes = core.entries.map(serializeEntry);
  return concatBytes(
    u8(txTypeTag(core.txType)),
    vec(entriesBytes),
    u64le(core.nonce),
    u32le(core.lockTime),
    u64le(core.fees),
    bytesVec(core.data),
  );
}

export function serializeCoreV2(core: TransactionCore): Uint8Array {
  // For v2, canonical encoding is the same field order; allow larger data blobs (bounded by node caps).
  if (core.data.length > 64 * 1024) throw new Error("core.data too large");
  const entriesBytes = core.entries.map(serializeEntry);
  return concatBytes(
    u8(txTypeTag(core.txType)),
    vec(entriesBytes),
    u64le(core.nonce),
    u32le(core.lockTime),
    u64le(core.fees),
    bytesVec(core.data),
  );
}

export function serializeTxV1(tx: Transaction): Uint8Array {
  if (tx.signature.length !== 64) throw new Error("signature must be 64 bytes");
  return concatBytes(
    serializeCoreV1(tx.core),
    bytesVec(tx.signature),
    u64le(tx.timestamp),
  );
}

function optionBytesVec(v: null | Uint8Array): Uint8Array {
  if (v === null) return u8(0x00);
  return concatBytes(u8(0x01), bytesVec(v));
}

export function serializeTxV2(tx: TransactionV2): Uint8Array {
  if (tx.signatureScheme !== 0) throw new Error("unsupported signature_scheme (only 0 allowed)");
  if (tx.senderPubkey !== null) throw new Error("sender_pubkey must be null (reserved for future schemes)");
  if (tx.signature.length !== 64) throw new Error("signature must be 64 bytes");
  return concatBytes(
    serializeCoreV2(tx.core),
    u8(tx.signatureScheme),
    bytesVec(tx.signature),
    optionBytesVec(tx.senderPubkey),
    u64le(tx.timestamp),
  );
}

export function encodeWireTxV1(tx: Transaction): Uint8Array {
  return concatBytes(TX_WIRE_MAGIC_V1, serializeTxV1(tx));
}

export function encodeWireTxV2(tx: TransactionV2): Uint8Array {
  return concatBytes(TX_WIRE_MAGIC_V2, serializeTxV2(tx));
}

export function txIdV1(tx: Transaction): `0x${string}` {
  const wire = encodeWireTxV1(tx);
  const digest64 = blake2b(wire, { dkLen: 64 });
  const id = digest64.slice(0, 32);
  return bytesToHex(id);
}

export function txIdV2(tx: TransactionV2): `0x${string}` {
  const txBytes = serializeTxV2(tx);
  const digest64 = blake2b(concatBytes(TX_WIRE_MAGIC_V2, txBytes), { dkLen: 64 });
  const id = digest64.slice(0, 32);
  return bytesToHex(id);
}

export function signingPayloadV1(args: {
  core: TransactionCore;
  timestamp: bigint;
  chainId: bigint;
  genesisHashHex: `0x${string}`;
}): Uint8Array {
  const genesis = hexToBytes(normalizeHex32(args.genesisHashHex));
  const coreBytes = serializeCoreV1(args.core);
  return concatBytes(
    TX_SIG_DOMAIN_V1,
    u64le(args.chainId),
    genesis,
    coreBytes,
    u64le(args.timestamp),
  );
}

export function signingPayloadV2(args: {
  core: TransactionCore;
  timestamp: bigint;
  chainId: bigint;
  genesisHashHex: `0x${string}`;
  signatureScheme: number; // u8
  senderPubkey: null | Uint8Array; // must be null for now
}): Uint8Array {
  if (args.signatureScheme !== 0) throw new Error("unsupported signature_scheme (only 0 allowed)");
  if (args.senderPubkey !== null) throw new Error("sender_pubkey must be null (reserved for future schemes)");
  const genesis = hexToBytes(normalizeHex32(args.genesisHashHex));
  const coreBytes = serializeCoreV2(args.core);
  return concatBytes(
    TX_SIG_DOMAIN_V2,
    u64le(args.chainId),
    genesis,
    u8(args.signatureScheme),
    optionBytesVec(args.senderPubkey),
    coreBytes,
    u64le(args.timestamp),
  );
}

function leBytesToBigInt(bytes: Uint8Array): bigint {
  let x = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) x = (x << 8n) + BigInt(bytes[i]!);
  return x;
}

const ORDER = ristretto255.Point.Fn.ORDER;

function hashToScalarBlake2b256(data: Uint8Array): bigint {
  // IMPORTANT: match Rust `blake2b_hash` implementation:
  // Blake2b512(data) then take first 32 bytes.
  // (This is NOT the same as Blake2b with outputLen=32 parameterization.)
  const h64 = blake2b(data, { dkLen: 64 });
  const h32 = h64.slice(0, 32);
  return leBytesToBigInt(h32) % ORDER;
}

export function signSchnorrRistretto(args: {
  privkeyHex: string;
  message: Uint8Array;
}): Uint8Array {
  const x = privkeyHexToScalar(args.privkeyHex);
  const P = ristretto255.Point.BASE.multiply(x).toBytes();

  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const k = leBytesToBigInt(nonceBytes) % ORDER;
  const R = ristretto255.Point.BASE.multiply(k);
  const Rbytes = R.toBytes();

  const e = hashToScalarBlake2b256(concatBytes(Rbytes, P, args.message));
  const s = (k + e * x) % ORDER;

  return concatBytes(Rbytes, scalarToBytesLE(s));
}

export function buildAndSignTransferTxV1(args: {
  privkeyHex: string;
  toPubkeyHex: `0x${string}`;
  amount: bigint;
  noncePlusOne: bigint;
  fees: bigint;
  lockTimeSeconds: number;
  timestampMs: bigint;
  chainId: bigint;
  genesisHashHex: `0x${string}`;
}): {
  fromPubkeyHex: `0x${string}`;
  tx: Transaction;
  wireHex: `0x${string}`;
  txIdHex: `0x${string}`;
} {
  const fromPubkeyHex = pubkeyFromPrivkeyHex(args.privkeyHex);
  const core: TransactionCore = {
    txType: "NonConfidentialTransfer",
    nonce: args.noncePlusOne,
    lockTime: args.lockTimeSeconds,
    fees: args.fees,
    data: new Uint8Array(),
    entries: [
      { publicKeyHex: fromPubkeyHex, amount: -args.amount },
      { publicKeyHex: normalizeHex32(args.toPubkeyHex), amount: args.amount },
    ],
  };

  const payload = signingPayloadV1({
    core,
    timestamp: args.timestampMs,
    chainId: args.chainId,
    genesisHashHex: args.genesisHashHex,
  });

  const sig = signSchnorrRistretto({ privkeyHex: args.privkeyHex, message: payload });

  const tx: Transaction = {
    core,
    signature: sig,
    timestamp: args.timestampMs,
  };

  const wire = encodeWireTxV1(tx);
  return {
    fromPubkeyHex,
    tx,
    wireHex: bytesToHex(wire),
    txIdHex: txIdV1(tx),
  };
}

export function buildAndSignTransferTxV2(args: {
  privkeyHex: string;
  toPubkeyHex: `0x${string}`;
  amount: bigint;
  noncePlusOne: bigint;
  fees: bigint;
  timestampMs: bigint;
  chainId: bigint;
  genesisHashHex: `0x${string}`;
}): {
  fromPubkeyHex: `0x${string}`;
  tx: TransactionV2;
  wireHex: `0x${string}`;
  txIdHex: `0x${string}`;
} {
  const fromPubkeyHex = pubkeyFromPrivkeyHex(args.privkeyHex);
  const core: TransactionCore = {
    txType: "NonConfidentialTransfer",
    nonce: args.noncePlusOne,
    lockTime: 0,
    fees: args.fees,
    data: new Uint8Array(),
    entries: [
      { publicKeyHex: fromPubkeyHex, amount: -args.amount },
      { publicKeyHex: normalizeHex32(args.toPubkeyHex), amount: args.amount },
    ],
  };

  const payload = signingPayloadV2({
    core,
    timestamp: args.timestampMs,
    chainId: args.chainId,
    genesisHashHex: args.genesisHashHex,
    signatureScheme: 0,
    senderPubkey: null,
  });

  const sig = signSchnorrRistretto({ privkeyHex: args.privkeyHex, message: payload });

  const tx: TransactionV2 = {
    core,
    signatureScheme: 0,
    signature: sig,
    senderPubkey: null,
    timestamp: args.timestampMs,
  };

  const wire = encodeWireTxV2(tx);
  return {
    fromPubkeyHex,
    tx,
    wireHex: bytesToHex(wire),
    txIdHex: txIdV2(tx),
  };
}

