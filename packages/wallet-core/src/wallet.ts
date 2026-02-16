import { pubkeyFromPrivkeyHex } from "@catalyst/catalyst-sdk";
import { validatePrivateKeyHex } from "./state.js";
import { deriveAccountAddressHexV1, deriveAccountPrivkeyHexV1, mnemonicToSeed } from "./derivation.js";

export type WalletKind = "mnemonic_v1" | "private_key_v1";

export type WalletAccountV2 = {
  id: string;
  label: string;
  addressHex: `0x${string}`;
  // Present only for mnemonic-derived accounts
  accountIndex?: number;
  createdAtMs: number;
};

export type WalletDataV2 = {
  version: 2;
  kind: WalletKind;
  name: string;
  createdAtMs: number;
  selectedAccountId: string;
  accounts: WalletAccountV2[];

  // secrets (stored encrypted in vault)
  mnemonic?: string;
  passphrase?: string;
  privateKeyHex?: `0x${string}`;

  // mnemonic bookkeeping
  nextAccountIndex?: number;
};

export type LegacyWalletPayload = {
  privateKeyHex: string;
  addressHex?: string;
};

function randomId(prefix: string): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  const uuid = g.crypto?.randomUUID?.();
  if (uuid) return `${prefix}_${uuid}`;
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function ensureAccountsNonEmpty(data: WalletDataV2): WalletDataV2 {
  if (data.accounts.length === 0) throw new Error("Wallet has no accounts");
  return data;
}

export function createMnemonicWalletV2(args: {
  name?: string;
  mnemonic: string;
  passphrase?: string;
  initialAccounts?: number; // default 1
}): WalletDataV2 {
  const createdAtMs = Date.now();
  const name = args.name ?? "My Wallet";
  const passphrase = args.passphrase ?? "";
  const initialAccounts = args.initialAccounts ?? 1;
  if (!Number.isInteger(initialAccounts) || initialAccounts < 1) throw new Error("initialAccounts must be >= 1");

  const seed64 = mnemonicToSeed(args.mnemonic, passphrase);
  const accounts: WalletAccountV2[] = [];
  for (let i = 0; i < initialAccounts; i++) {
    const addressHex = deriveAccountAddressHexV1({ seed64, accountIndex: i });
    accounts.push({
      id: randomId("acct"),
      label: `Account ${i + 1}`,
      addressHex,
      accountIndex: i,
      createdAtMs,
    });
  }
  const selectedAccountId = accounts[0]!.id;
  return ensureAccountsNonEmpty({
    version: 2,
    kind: "mnemonic_v1",
    name,
    createdAtMs,
    selectedAccountId,
    accounts,
    mnemonic: args.mnemonic,
    passphrase,
    nextAccountIndex: initialAccounts,
  });
}

export function createPrivateKeyWalletV2(args: { name?: string; privateKeyHex: string }): WalletDataV2 {
  const createdAtMs = Date.now();
  const name = args.name ?? "Imported Key";
  const privateKeyHex = validatePrivateKeyHex(args.privateKeyHex);
  const addressHex = pubkeyFromPrivkeyHex(privateKeyHex);
  const acct: WalletAccountV2 = {
    id: randomId("acct"),
    label: "Account 1",
    addressHex,
    createdAtMs,
  };
  return {
    version: 2,
    kind: "private_key_v1",
    name,
    createdAtMs,
    selectedAccountId: acct.id,
    accounts: [acct],
    privateKeyHex,
  };
}

export function parseWalletDataAny(payload: unknown): WalletDataV2 {
  if (!payload || typeof payload !== "object") throw new Error("Invalid wallet payload");
  const p = payload as Record<string, unknown>;
  if (p.version === 2) return ensureAccountsNonEmpty(p as WalletDataV2);
  // Legacy: { privateKeyHex, addressHex? }
  if (typeof p.privateKeyHex === "string") {
    return createPrivateKeyWalletV2({ privateKeyHex: p.privateKeyHex });
  }
  throw new Error("Unknown wallet payload version");
}

export function getSelectedAccount(data: WalletDataV2): WalletAccountV2 {
  const byId = data.accounts.find((a) => a.id === data.selectedAccountId);
  return byId ?? data.accounts[0]!;
}

export function selectAccount(data: WalletDataV2, accountId: string): WalletDataV2 {
  if (!data.accounts.some((a) => a.id === accountId)) throw new Error("Unknown account");
  return { ...data, selectedAccountId: accountId };
}

export function addAccount(data: WalletDataV2, label?: string): WalletDataV2 {
  if (data.kind !== "mnemonic_v1") throw new Error("Can only add accounts to mnemonic wallets");
  if (!data.mnemonic) throw new Error("Missing mnemonic");
  const passphrase = data.passphrase ?? "";
  const seed64 = mnemonicToSeed(data.mnemonic, passphrase);
  const idx = data.nextAccountIndex ?? data.accounts.length;
  const addressHex = deriveAccountAddressHexV1({ seed64, accountIndex: idx });
  const acct: WalletAccountV2 = {
    id: randomId("acct"),
    label: label ?? `Account ${idx + 1}`,
    addressHex,
    accountIndex: idx,
    createdAtMs: Date.now(),
  };
  return {
    ...data,
    accounts: [...data.accounts, acct],
    selectedAccountId: acct.id,
    nextAccountIndex: idx + 1,
  };
}

export function getPrivateKeyHexForAccount(data: WalletDataV2, accountId: string): `0x${string}` {
  const acct = data.accounts.find((a) => a.id === accountId);
  if (!acct) throw new Error("Unknown account");

  if (data.kind === "private_key_v1") {
    if (!data.privateKeyHex) throw new Error("Missing private key");
    return data.privateKeyHex;
  }

  if (data.kind === "mnemonic_v1") {
    if (!data.mnemonic) throw new Error("Missing mnemonic");
    if (acct.accountIndex === undefined) throw new Error("Mnemonic account missing accountIndex");
    const seed64 = mnemonicToSeed(data.mnemonic, data.passphrase ?? "");
    return deriveAccountPrivkeyHexV1({ seed64, accountIndex: acct.accountIndex });
  }

  throw new Error("Unsupported wallet kind");
}

