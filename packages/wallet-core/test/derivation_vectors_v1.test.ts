import { describe, expect, it } from "vitest";
import vectors from "./fixtures/derivation_vectors_v1.json";
import { deriveAccountAddressHexV1, deriveAccountPrivkeyHexV1, mnemonicToSeed } from "../src/derivation.js";
import { pubkeyFromPrivkeyHex } from "@catalyst/catalyst-sdk";

describe("Catalyst Wallet v1 derivation vectors", () => {
  it("derives expected privkeys and addresses", () => {
    for (const v of vectors.vectors) {
      const seed = mnemonicToSeed(v.mnemonic, v.passphrase);
      expect(seed.length).toBe(64);
      // seed_hex is an extra sanity check (optional)
      // (We don't compare seed_hex here to avoid coupling tests to hex helpers.)

      for (const acct of v.accounts) {
        const priv = deriveAccountPrivkeyHexV1({ seed64: seed, accountIndex: acct.account_index });
        expect(priv).toBe(acct.privkey_hex);

        const addr = deriveAccountAddressHexV1({ seed64: seed, accountIndex: acct.account_index });
        expect(addr).toBe(acct.address_hex);

        // cross-check: address is derived from privkey formatting rules
        expect(pubkeyFromPrivkeyHex(priv)).toBe(acct.address_hex);
      }
    }
  });
});

