import { describe, expect, it } from "vitest";
import { parseWalletDataAny } from "../src/wallet.js";

describe("wallet payload parsing", () => {
  it("migrates legacy payload { privateKeyHex } to WalletDataV2", () => {
    const legacy = { privateKeyHex: "0x" + "11".repeat(32) };
    const wd = parseWalletDataAny(legacy);
    expect(wd.version).toBe(2);
    expect(wd.kind).toBe("private_key_v1");
    expect(wd.accounts.length).toBe(1);
    expect(wd.privateKeyHex).toBe(legacy.privateKeyHex);
    expect(wd.accounts[0]!.addressHex.startsWith("0x")).toBe(true);
  });
});

