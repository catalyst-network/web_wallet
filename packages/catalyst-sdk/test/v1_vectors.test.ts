import { describe, expect, it } from "vitest";
import vectors from "./fixtures/v1_vectors.json";
import { bytesToHex, hexToBytes, normalizeHex32 } from "../src/hex.js";
import { encodeWireTxV1, signingPayloadV1, txIdV1, type Transaction } from "../src/tx.js";

const EXPECTED = {
  signing_payload_v1_hex:
    "0x434154414c5953545f5349475f5631697a00000000000000000000000000000000000000000000000000000000000000000000000000000002000000010101010101010101010101010101010101010101010101010101010101010100f9ffffffffffffff02020202020202020202020202020202020202020202020202020202020202020007000000000000000100000000000000000000000300000000000000000000000068e5cf8b010000",
  wire_tx_v1_hex:
    "0x435458310002000000010101010101010101010101010101010101010101010101010101010101010100f9ffffffffffffff020202020202020202020202020202020202020202020202020202020202020200070000000000000001000000000000000000000003000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000068e5cf8b010000",
  tx_id_v1_hex:
    "0x0da2e9dad155e0f38a4e7dfd109c5afb458e01fa6ac55363ceeb20a4d2098a0f",
};

describe("Catalyst wallet tx v1 vectors", () => {
  it("matches signing payload, wire encoding, and tx_id", () => {
    const signatureBytes = hexToBytes(vectors.tx.signature_hex as `0x${string}`);
    expect(signatureBytes.length).toBe(64);

    const tx: Transaction = {
      core: {
        txType: "NonConfidentialTransfer",
        nonce: BigInt(vectors.tx.nonce),
        lockTime: vectors.tx.lock_time,
        fees: BigInt(vectors.tx.fees),
        data: new Uint8Array(),
        entries: vectors.tx.entries.map((e) => ({
          publicKeyHex: normalizeHex32(e.public_key_hex),
          amount: BigInt(e.amount),
        })),
      },
      signature: signatureBytes,
      timestamp: BigInt(vectors.tx.timestamp),
    };

    const payload = signingPayloadV1({
      core: tx.core,
      timestamp: tx.timestamp,
      chainId: BigInt(vectors.chain_id_hex as `0x${string}`),
      genesisHashHex: normalizeHex32(vectors.genesis_hash_hex),
    });
    expect(bytesToHex(payload)).toBe(EXPECTED.signing_payload_v1_hex);

    const wire = encodeWireTxV1(tx);
    expect(bytesToHex(wire)).toBe(EXPECTED.wire_tx_v1_hex);

    expect(txIdV1(tx)).toBe(EXPECTED.tx_id_v1_hex);
  });
});

