import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CATALYST_TESTNET,
  CatalystRpcClient,
  CATALYST_TESTNET_DEV_FAUCET_PRIVKEY_HEX,
  assertChainIdentity,
  RpcTimeoutError,
  buildAndSignTransferTxV1,
  normalizeHex32,
  pubkeyFromPrivkeyHex,
} from "@catalyst/catalyst-sdk";
import {
  addAccount,
  createMnemonic,
  createMnemonicWalletV2,
  createPrivateKeyWalletV2,
  createVaultV1,
  getPrivateKeyHexForAccount,
  getSelectedAccount,
  isValidMnemonic,
  openVaultV1,
  parseWalletDataAny,
  selectAccount,
  type VaultRecordV1,
  type WalletDataV2,
} from "@catalyst/wallet-core";
import { CatalystLogo } from "./CatalystLogo.js";

type UiTx = {
  localTxId: `0x${string}`;
  rpcTxId?: `0x${string}`;
  status?: string;
  lastReceipt?: unknown;
  lastCheckedAtMs?: number;
  createdAtMs: number;
};

const LS_VAULT = "catalyst_wallet_vault_v1";
const LS_RPC_URL = "catalyst_wallet_rpc_url";
const LS_TXS_PREFIX = "catalyst_wallet_txs_v1";
const LS_CHAIN_HISTORY_PREFIX = "catalyst_wallet_chain_history_v1";

const EXPLORER_BASE_URL = "https://explorer.catalystnet.org";

function explorerTxUrl(txid: string): string {
  // Explorer is expected to route tx pages by hash.
  return `${EXPLORER_BASE_URL}/tx/${txid}`;
}
function explorerBlockUrl(cycle: number): string {
  return `${EXPLORER_BASE_URL}/block/${cycle}`;
}

function readVault(): VaultRecordV1 | null {
  const raw = localStorage.getItem(LS_VAULT);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VaultRecordV1;
  } catch {
    return null;
  }
}

function writeVault(v: VaultRecordV1) {
  localStorage.setItem(LS_VAULT, JSON.stringify(v));
}

function readJson<T>(key: string): T | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
function writeJson(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

function bytesToUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}
function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

  // Minimal select styling by reusing existing input styles
  // (The global CSS already styles inputs/buttons/textarea; we add select below.)

type OnboardingMode = "choose" | "create" | "restore" | "import";

function shortHex(hex: string, left = 10, right = 8): string {
  if (!hex || hex.length <= left + right + 1) return hex;
  return `${hex.slice(0, left)}…${hex.slice(-right)}`;
}

function nowMs(): bigint {
  return BigInt(Date.now());
}

function nowSecondsU32(): number {
  const s = Math.floor(Date.now() / 1000);
  return Math.max(0, Math.min(0xffffffff, s));
}

function randomPrivkeyHex(): `0x${string}` {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s as `0x${string}`;
}

export function App() {
  // Default to same-origin "/rpc" in dev (avoids CORS), HTTPS in production.
  const [rpcBaseUrl, setRpcBaseUrl] = useState(
    () =>
      localStorage.getItem(LS_RPC_URL) ??
      (import.meta.env.DEV ? "/rpc" : CATALYST_TESTNET.rpcUrls[0]!),
  );
  const rpcUrls = useMemo(() => {
    const base = rpcBaseUrl.trim();
    if (!base) return [...CATALYST_TESTNET.rpcUrls];
    if (base.startsWith("/")) return [base];
    return [base, ...CATALYST_TESTNET.rpcUrls.filter((u) => u !== base)];
  }, [rpcBaseUrl]);
  const rpc = useMemo(() => new CatalystRpcClient(rpcUrls), [rpcUrls.join("|")]);

  const [vault, setVault] = useState<VaultRecordV1 | null>(() => readVault());
  const [locked, setLocked] = useState(true);
  const [sessionPassword, setSessionPassword] = useState<string | null>(null);
  const [walletData, setWalletData] = useState<WalletDataV2 | null>(null);

  const [password, setPassword] = useState("");
  const [addressHex, setAddressHex] = useState<`0x${string}` | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [privkeyHex, setPrivkeyHex] = useState<`0x${string}` | null>(null);

  // Onboarding state (when no vault exists)
  const [onboardingMode, setOnboardingMode] = useState<OnboardingMode>("choose");
  const [onboardPassword, setOnboardPassword] = useState("");
  const [createWords, setCreateWords] = useState<12 | 24>(12);
  const [createMnemonicText, setCreateMnemonicText] = useState<string>(() => createMnemonic(128));
  const [createConfirmIdxs, setCreateConfirmIdxs] = useState<number[]>(() => [1, 6, 12]);
  const [createConfirmWords, setCreateConfirmWords] = useState<string[]>(() => ["", "", ""]);
  const [restoreMnemonic, setRestoreMnemonic] = useState("");
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [importPrivkeyHex, setImportPrivkeyHex] = useState<string>(() => randomPrivkeyHex());
  const [onboardError, setOnboardError] = useState<string | null>(null);

  // Backup / export (re-auth)
  const [revealMode, setRevealMode] = useState<null | "mnemonic" | "private_key">(null);
  const [revealPassword, setRevealPassword] = useState("");
  const [revealBusy, setRevealBusy] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [revealedText, setRevealedText] = useState<string | null>(null);
  const [revealAck, setRevealAck] = useState(false);
  const [revealCooldownUntilMs, setRevealCooldownUntilMs] = useState(0);
  const [revealFailures, setRevealFailures] = useState(0);
  const revealHideTimerRef = useRef<number | null>(null);

  const [chainOk, setChainOk] = useState<boolean | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);

  const [balance, setBalance] = useState<bigint | null>(null);
  const [nonce, setNonce] = useState<bigint | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [nextNonceHint, setNextNonceHint] = useState<bigint | null>(null);

  const [toHex, setToHex] = useState("");
  const [amountStr, setAmountStr] = useState("1");
  const [fee, setFee] = useState<bigint | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendOk, setSendOk] = useState<string | null>(null);
  const [txs, setTxs] = useState<UiTx[]>([]);
  const [sendBusy, setSendBusy] = useState(false);
  const [history, setHistory] = useState<import("@catalyst/catalyst-sdk").RpcTransactionSummary[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [faucetAmountStr, setFaucetAmountStr] = useState("1000");
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const [faucetOk, setFaucetOk] = useState<string | null>(null);
  const [faucetNextNonceHint, setFaucetNextNonceHint] = useState<bigint | null>(null);

  const pollTimer = useRef<number | null>(null);
  const nextNonceByAddrRef = useRef<Map<string, bigint>>(new Map());
  const nonceLocksRef = useRef<Map<string, Promise<void>>>(new Map());

  useEffect(() => {
    localStorage.setItem(LS_RPC_URL, rpcBaseUrl);
  }, [rpcBaseUrl]);

  const txsStorageKey = useMemo(() => {
    if (!addressHex) return null;
    return `${LS_TXS_PREFIX}:${CATALYST_TESTNET.networkId}:${addressHex.toLowerCase()}`;
  }, [addressHex]);
  const chainHistoryStorageKey = useMemo(() => {
    if (!addressHex) return null;
    return `${LS_CHAIN_HISTORY_PREFIX}:${CATALYST_TESTNET.networkId}:${addressHex.toLowerCase()}`;
  }, [addressHex]);

  useEffect(() => {
    if (!addressHex) return;
    // Restore persisted local tx list + last fetched on-chain history for this address.
    const stx = txsStorageKey ? readJson<UiTx[]>(txsStorageKey) : null;
    if (Array.isArray(stx)) setTxs(stx);
    const sh = chainHistoryStorageKey
      ? readJson<import("@catalyst/catalyst-sdk").RpcTransactionSummary[]>(chainHistoryStorageKey)
      : null;
    if (Array.isArray(sh)) setHistory(sh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressHex]);

  useEffect(() => {
    if (!txsStorageKey) return;
    // Keep persisted tx list bounded.
    const bounded = txs.slice(0, 50);
    writeJson(txsStorageKey, bounded);
  }, [txs, txsStorageKey]);

  useEffect(() => {
    if (!chainHistoryStorageKey) return;
    writeJson(chainHistoryStorageKey, history.slice(0, 50));
  }, [history, chainHistoryStorageKey]);

  useEffect(() => {
    // reset chain state on rpc changes
    setChainOk(null);
    setChainError(null);
  }, [rpcBaseUrl]);

  const verifyChain = useCallback(async () => {
    setChainOk(null);
    setChainError(null);
    try {
      await assertChainIdentity(rpc, CATALYST_TESTNET);
      setChainOk(true);
      setChainError(null);
    } catch (e) {
      setChainOk(false);
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "Failed to fetch" && import.meta.env.DEV) {
        setChainError(
          `Cannot reach RPC from the browser (likely CORS). In dev, set RPC URL to "/rpc" and run with VITE_RPC_TARGET=${CATALYST_TESTNET.rpcUrls[0]}`,
        );
      } else {
        setChainError(msg);
      }
    }
  }, [rpc]);

  async function ensureChainIdentityOk(): Promise<void> {
    await assertChainIdentity(rpc, CATALYST_TESTNET);
    setChainOk(true);
    setChainError(null);
  }

  useEffect(() => {
    if (!walletData) return;
    const acct = getSelectedAccount(walletData);
    setSelectedAccountId(acct.id);
    setAddressHex(acct.addressHex);
    try {
      setPrivkeyHex(getPrivateKeyHexForAccount(walletData, acct.id));
    } catch {
      setPrivkeyHex(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletData]);

  useEffect(() => {
    // Try automatically on load / when RPC changes.
    // (Still allow manual retry via the UI button.)
    verifyChain().catch(() => {});
  }, [verifyChain]);

  async function unlock() {
    setSendOk(null);
    setSendError(null);
    setRefreshError(null);
    const v = vault ?? readVault();
    if (!v) throw new Error("No vault found");
    const plaintext = openVaultV1({ password, record: v });
    const json = JSON.parse(bytesToUtf8(plaintext)) as unknown;
    const wd = parseWalletDataAny(json);
    setWalletData(wd);
    setLocked(false);
    setSessionPassword(password);
    setPassword("");
    setVault(v);
  }

  function lock() {
    setLocked(true);
    setWalletData(null);
    setSelectedAccountId(null);
    setPrivkeyHex(null);
    setAddressHex(null);
    setSessionPassword(null);
    setBalance(null);
    setNonce(null);
    setNextNonceHint(null);
    setFee(null);
    setTxs([]);
  }

  async function persistWallet(updated: WalletDataV2) {
    if (!sessionPassword) throw new Error("Wallet is locked");
    const record = createVaultV1({ password: sessionPassword, plaintext: utf8ToBytes(JSON.stringify(updated)) });
    writeVault(record);
    setVault(record);
    setWalletData(updated);
  }

  async function switchAccount(accountId: string) {
    if (!walletData) return;
    const updated = selectAccount(walletData, accountId);
    await persistWallet(updated);
    const acct = getSelectedAccount(updated);
    setSelectedAccountId(acct.id);
    setAddressHex(acct.addressHex);
    setPrivkeyHex(getPrivateKeyHexForAccount(updated, acct.id));
  }

  async function addNewAccount() {
    if (!walletData) return;
    const updated = addAccount(walletData);
    await persistWallet(updated);
    const acct = getSelectedAccount(updated);
    setSelectedAccountId(acct.id);
    setAddressHex(acct.addressHex);
    setPrivkeyHex(getPrivateKeyHexForAccount(updated, acct.id));
  }

  async function completeOnboardingCreate() {
    setOnboardError(null);
    try {
      if (!onboardPassword) throw new Error("Password is required");
      if (!isValidMnemonic(createMnemonicText.trim())) throw new Error("Mnemonic is invalid");

      const words = createMnemonicText.trim().split(/\s+/).map((w) => w.toLowerCase());
      if (words.length !== (createWords === 12 ? 12 : 24)) throw new Error("Mnemonic word count mismatch");
      const entered = createConfirmWords.map((w) => w.trim().toLowerCase());
      if (createConfirmIdxs.length !== 3 || entered.length !== 3) throw new Error("Invalid confirmation state");
      for (let i = 0; i < 3; i++) {
        const idx1 = createConfirmIdxs[i]!;
        const expected = words[idx1 - 1];
        if (!expected) throw new Error("Invalid confirmation index");
        if (entered[i] !== expected) throw new Error(`Confirmation failed for word #${idx1}`);
      }

      const wd = createMnemonicWalletV2({
        mnemonic: createMnemonicText.trim(),
        passphrase: "",
        initialAccounts: 1,
      });
      const record = createVaultV1({ password: onboardPassword, plaintext: utf8ToBytes(JSON.stringify(wd)) });
      writeVault(record);
      setVault(record);
      setOnboardPassword("");
      setOnboardingMode("choose");
    } catch (e) {
      setOnboardError(e instanceof Error ? e.message : String(e));
    }
  }

  function pickConfirmIdxs(count: 12 | 24): number[] {
    // Choose 3 distinct 1-indexed positions.
    const set = new Set<number>();
    while (set.size < 3) {
      const n = 1 + Math.floor(Math.random() * count);
      set.add(n);
    }
    return Array.from(set).sort((a, b) => a - b);
  }

  function resetCreateMnemonic(nextWords: 12 | 24) {
    setCreateWords(nextWords);
    setCreateMnemonicText(createMnemonic(nextWords === 12 ? 128 : 256));
    setCreateConfirmIdxs(pickConfirmIdxs(nextWords));
    setCreateConfirmWords(["", "", ""]);
  }

  async function revealSecret(mode: "mnemonic" | "private_key") {
    if (!vault) return;
    if (!walletData) return;
    if (!selectedAccountId) return;
    if (!revealAck) {
      setRevealError("Please confirm you understand the risks before revealing secrets.");
      return;
    }
    const now = Date.now();
    if (now < revealCooldownUntilMs) {
      const secs = Math.ceil((revealCooldownUntilMs - now) / 1000);
      setRevealError(`Too many failed attempts. Try again in ${secs}s.`);
      return;
    }
    if (!revealPassword) {
      setRevealError("Password is required");
      return;
    }
    setRevealBusy(true);
    setRevealError(null);
    setRevealedText(null);
    try {
      // Re-auth by decrypting the vault again with the provided password.
      const plaintext = openVaultV1({ password: revealPassword, record: vault });
      const json = JSON.parse(bytesToUtf8(plaintext)) as unknown;
      const wd = parseWalletDataAny(json);

      if (mode === "mnemonic") {
        if (wd.kind !== "mnemonic_v1" || !wd.mnemonic) throw new Error("This wallet does not have a mnemonic");
        setRevealedText(wd.mnemonic);
        setRevealMode("mnemonic");
      } else {
        const pk = getPrivateKeyHexForAccount(wd, wd.selectedAccountId);
        setRevealedText(pk);
        setRevealMode("private_key");
      }
      setRevealPassword("");
      setRevealFailures(0);
      setRevealCooldownUntilMs(0);

      // Auto-hide after 30s.
      if (revealHideTimerRef.current) window.clearTimeout(revealHideTimerRef.current);
      revealHideTimerRef.current = window.setTimeout(() => {
        setRevealedText(null);
        setRevealMode(null);
      }, 30_000);
    } catch (e) {
      setRevealError(e instanceof Error ? e.message : String(e));
      const nextFailures = revealFailures + 1;
      setRevealFailures(nextFailures);
      const delayMs = Math.min(60_000, 1000 * 2 ** Math.min(6, nextFailures)); // 2s..64s capped
      setRevealCooldownUntilMs(Date.now() + delayMs);
    } finally {
      setRevealBusy(false);
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  }

  async function refreshHistory() {
    if (!addressHex) return;
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      const list = await rpc.getTransactionsByAddress({ addressHex32: addressHex, fromCycle: null, limit: 25 });
      setHistory(list);
    } catch (e) {
      // Timeouts can happen under load; ignore to keep polling calm.
      if (e instanceof RpcTimeoutError) return;
      setHistoryError(e instanceof Error ? e.message : String(e));
    } finally {
      setHistoryBusy(false);
    }
  }

  function wipeLocalHistory() {
    if (!txsStorageKey || !chainHistoryStorageKey) return;
    localStorage.removeItem(txsStorageKey);
    localStorage.removeItem(chainHistoryStorageKey);
    setTxs([]);
    setHistory([]);
  }

  function openExplorerTx(txid: string) {
    window.open(explorerTxUrl(txid), "_blank", "noopener,noreferrer");
  }

  function renderHistoryItem(h: import("@catalyst/catalyst-sdk").RpcTransactionSummary) {
    const me = (addressHex ?? "").toLowerCase();
    const from = (h.from ?? "").toString();
    const to = h.to ?? null;
    const fromLc = from.toLowerCase();
    const toLc = (to ?? "").toString().toLowerCase();

    let direction: "sent" | "received" | "other" = "other";
    let counterparty: string | null = null;
    if (me && fromLc === me) {
      direction = "sent";
      counterparty = to;
    } else if (me && toLc === me) {
      direction = "received";
      counterparty = from;
    }

    let signedValue = h.value;
    try {
      const v = BigInt(h.value);
      if (direction === "sent") signedValue = `-${v.toString(10)}`;
      if (direction === "received") signedValue = `+${v.toString(10)}`;
    } catch {
      // keep as string
    }

    return (
      <div
        key={h.hash}
        className="kv"
        style={{ gridTemplateColumns: "100px 1fr", padding: "10px 0", borderTop: "1px solid rgba(255,255,255,0.08)" }}
      >
        <div className="k">type</div>
        <div className="row">
          <span className={`pill ${direction}`}>{direction}</span>
          <span className="small">value</span>
          <span className="v">{signedValue}</span>
        </div>

        <div className="k">with</div>
        <div className="row">
          <span className="v" title={counterparty ?? ""}>{counterparty ? shortHex(counterparty) : "—"}</span>
          {counterparty ? (
            <button className="secondary miniBtn" onClick={() => copyToClipboard(counterparty!)}>
              Copy
            </button>
          ) : null}
        </div>

        <div className="k">hash</div>
        <div className="row">
          <span className="v" title={h.hash}>{shortHex(h.hash, 14, 10)}</span>
          <button className="secondary miniBtn" onClick={() => copyToClipboard(h.hash)}>
            Copy
          </button>
          <button className="secondary miniBtn" onClick={() => openExplorerTx(h.hash)}>
            Explorer
          </button>
        </div>
      </div>
    );
  }

  async function completeOnboardingRestore() {
    setOnboardError(null);
    try {
      if (!onboardPassword) throw new Error("Password is required");
      if (!isValidMnemonic(restoreMnemonic.trim())) throw new Error("Mnemonic is invalid");
      const wd = createMnemonicWalletV2({
        mnemonic: restoreMnemonic.trim(),
        passphrase: restorePassphrase,
        initialAccounts: 1,
      });
      const record = createVaultV1({ password: onboardPassword, plaintext: utf8ToBytes(JSON.stringify(wd)) });
      writeVault(record);
      setVault(record);
      setOnboardPassword("");
      setRestoreMnemonic("");
      setRestorePassphrase("");
      setOnboardingMode("choose");
    } catch (e) {
      setOnboardError(e instanceof Error ? e.message : String(e));
    }
  }

  async function completeOnboardingImport() {
    setOnboardError(null);
    try {
      if (!onboardPassword) throw new Error("Password is required");
      const wd = createPrivateKeyWalletV2({ privateKeyHex: importPrivkeyHex.trim() });
      const record = createVaultV1({ password: onboardPassword, plaintext: utf8ToBytes(JSON.stringify(wd)) });
      writeVault(record);
      setVault(record);
      setOnboardPassword("");
      setOnboardingMode("choose");
    } catch (e) {
      setOnboardError(e instanceof Error ? e.message : String(e));
    }
  }

  async function allocateNonce(senderHex32: string): Promise<bigint> {
    // Per-sender queue to ensure sequential allocation even with rapid clicks.
    const prev = nonceLocksRef.current.get(senderHex32) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    nonceLocksRef.current.set(senderHex32, prev.then(() => next));

    await prev;
    try {
      let n = nextNonceByAddrRef.current.get(senderHex32);
      if (n === undefined) {
        const committed = await rpc.getNonce(senderHex32);
        n = committed + 1n;
      }
      nextNonceByAddrRef.current.set(senderHex32, n + 1n);
      if (senderHex32 === addressHex) setNextNonceHint(n + 1n);
      if (senderHex32 === faucetAddressHex) setFaucetNextNonceHint(n + 1n);
      return n;
    } finally {
      release();
    }
  }

  function bumpNextNonceFloor(senderHex32: string, committedNonce: bigint) {
    const floor = committedNonce + 1n;
    const cur = nextNonceByAddrRef.current.get(senderHex32);
    if (cur === undefined || cur < floor) {
      nextNonceByAddrRef.current.set(senderHex32, floor);
      if (senderHex32 === addressHex) setNextNonceHint(floor);
      if (senderHex32 === faucetAddressHex) setFaucetNextNonceHint(floor);
    }
  }

  async function refreshAccount() {
    if (!addressHex) return;
    setRefreshError(null);
    try {
      const [b, n] = await Promise.all([rpc.getBalance(addressHex), rpc.getNonce(addressHex)]);
      setBalance(b);
      setNonce(n);
      bumpNextNonceFloor(addressHex, n);
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : String(e));
    }
  }

  async function estimateFee() {
    if (!addressHex) return;
    setSendError(null);
    setSendOk(null);
    const to = normalizeHex32(toHex.trim());
    const amount = BigInt(amountStr.trim());
    if (amount <= 0n) throw new Error("Amount must be > 0");
    const f = await rpc.estimateFee({
      from: addressHex,
      to,
      value: amount.toString(10),
      data: null,
      gas_limit: null,
      gas_price: null,
    });
    setFee(f);
  }

  async function send() {
    if (!privkeyHex || !addressHex) return;
    if (sendBusy) return;
    setSendError(null);
    setSendOk(null);
    setSendBusy(true);

    try {
      // Enforce identity check immediately before signing/broadcasting.
      await ensureChainIdentityOk();

      const to = normalizeHex32(toHex.trim());
      const amount = BigInt(amountStr.trim());
      if (amount <= 0n) throw new Error("Amount must be > 0");
      const fees =
        fee ??
        (await rpc.estimateFee({
          from: addressHex,
          to,
          value: amount.toString(),
          data: null,
          gas_limit: null,
          gas_price: null,
        }));

      // Preflight: if you don't have enough funds, the tx may sit pending and never apply.
      // If sending to self, the net transfer is 0 and only fees matter.
      const bal = balance ?? (await rpc.getBalance(addressHex));
      const required = to === addressHex ? fees : amount + fees;
      if (bal < required) {
        throw new Error(
          `Insufficient balance: have=${bal.toString(10)} need=${required.toString(10)} (includes fees)`,
        );
      }

      // Allocate a unique nonce for this send (committed_nonce+1, +2, +3, ...)
      const nonceToUse = await allocateNonce(addressHex);

      const built = buildAndSignTransferTxV1({
        privkeyHex,
        toPubkeyHex: to,
        amount,
        noncePlusOne: nonceToUse,
        fees,
        lockTimeSeconds: nowSecondsU32(),
        timestampMs: nowMs(),
        chainId: CATALYST_TESTNET.chainId,
        genesisHashHex: CATALYST_TESTNET.genesisHashHex,
      });

      const localTxId = built.txIdHex;
      setTxs((prev) => [{ localTxId, createdAtMs: Date.now() }, ...prev]);

      const rpcTxId = await rpc.sendRawTransaction(built.wireHex);
      setTxs((prev) =>
        prev.map((t) => (t.localTxId === localTxId ? { ...t, rpcTxId, status: "pending" } : t)),
      );
      setSendOk(`Submitted. tx_id: ${rpcTxId}`);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
      // If we raced on-chain nonce (e.g., other wallet instance), re-floor from RPC next refresh.
    }
    finally {
      setSendBusy(false);
    }
  }

  const faucetEnabled =
    import.meta.env.DEV &&
    (import.meta.env.VITE_ENABLE_DEV_FAUCET === "true") &&
    CATALYST_TESTNET.networkId === "catalyst-testnet";
  const faucetAddressHex = useMemo(
    () => (faucetEnabled ? pubkeyFromPrivkeyHex(CATALYST_TESTNET_DEV_FAUCET_PRIVKEY_HEX) : null),
    [faucetEnabled],
  );

  useEffect(() => {
    // If we know faucet address, precompute its next nonce floor once (cheap) to reduce collisions.
    if (!faucetAddressHex) return;
    rpc
      .getNonce(faucetAddressHex)
      .then((n) => bumpNextNonceFloor(faucetAddressHex, n))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faucetAddressHex, rpcBaseUrl]);

  async function requestFaucetFunds() {
    if (!faucetEnabled) return;
    if (!addressHex) return;
    if (!faucetAddressHex) return;

    setFaucetBusy(true);
    setFaucetError(null);
    setFaucetOk(null);

    try {
      // Enforce identity check immediately before signing/broadcasting.
      await ensureChainIdentityOk();

      const amount = BigInt(faucetAmountStr.trim());
      if (amount <= 0n) throw new Error("Amount must be > 0");

      const fees = await rpc.estimateFee({
        from: faucetAddressHex,
        to: addressHex,
        value: amount.toString(10),
        data: null,
        gas_limit: null,
        gas_price: null,
      });

      // Retry once on potential nonce race.
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // Faucet is a shared account; still allocate locally to avoid double-sends from this UI.
          // If another faucet user races us, the retry will pick up a new committed nonce.
          const committed = await rpc.getNonce(faucetAddressHex);
          bumpNextNonceFloor(faucetAddressHex, committed);
          const faucetNonceToUse = await allocateNonce(faucetAddressHex);
          const built = buildAndSignTransferTxV1({
            privkeyHex: CATALYST_TESTNET_DEV_FAUCET_PRIVKEY_HEX,
            toPubkeyHex: addressHex,
            amount,
            noncePlusOne: faucetNonceToUse,
            fees,
            lockTimeSeconds: nowSecondsU32(),
            timestampMs: nowMs(),
            chainId: CATALYST_TESTNET.chainId,
            genesisHashHex: CATALYST_TESTNET.genesisHashHex,
          });

          const localTxId = built.txIdHex;
          setTxs((prev) => [{ localTxId, createdAtMs: Date.now(), status: "pending" }, ...prev]);

          const rpcTxId = await rpc.sendRawTransaction(built.wireHex);
          setTxs((prev) =>
            prev.map((t) => (t.localTxId === localTxId ? { ...t, rpcTxId, status: "pending" } : t)),
          );
          setFaucetOk(`Faucet transfer submitted. tx_id: ${rpcTxId}`);

          // Refresh after a short delay; receipt polling will continue.
          setTimeout(() => {
            refreshAccount().catch(() => {});
          }, 1500);
          return;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    } catch (e) {
      setFaucetError(e instanceof Error ? e.message : String(e));
    } finally {
      setFaucetBusy(false);
    }
  }

  useEffect(() => {
    if (!locked && addressHex) {
      refreshAccount().catch(() => {});
      refreshHistory().catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, addressHex]);

  useEffect(() => {
    if (pollTimer.current) window.clearInterval(pollTimer.current);
    if (locked) return;
    pollTimer.current = window.setInterval(async () => {
      const pending = txs.filter((t) => (t.rpcTxId ?? t.localTxId) && t.status !== "applied" && t.status !== "dropped");
      if (pending.length === 0) return;
      for (const t of pending) {
        const id = t.rpcTxId ?? t.localTxId;
        try {
          const r = await rpc.getTransactionReceipt(id);
          const becameApplied = t.status !== "applied" && r?.status === "applied";
          setTxs((prev) =>
            prev.map((x) =>
              x.localTxId === t.localTxId
                ? {
                    ...x,
                    status: r?.status ?? "not_found",
                    lastReceipt: r,
                    lastCheckedAtMs: Date.now(),
                  }
                : x,
            ),
          );
          if (becameApplied) {
            refreshAccount().catch(() => {});
            refreshHistory().catch(() => {});
          }
        } catch {
          // ignore transient failures
        }
      }
    }, 2500);
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    };
  }, [locked, rpc, txs]);

  const hasVault = !!vault;
  const chainStatus =
    chainOk === null ? "checking…" : chainOk ? "verified" : chainError ? "error" : "mismatch";

  async function checkTxNow(localTxId: `0x${string}`) {
    const t = txs.find((x) => x.localTxId === localTxId);
    if (!t) return;
    const id = t.rpcTxId ?? t.localTxId;
    try {
      const r = await rpc.getTransactionReceipt(id);
      setTxs((prev) =>
        prev.map((x) =>
          x.localTxId === localTxId
            ? { ...x, status: r?.status ?? "not_found", lastReceipt: r, lastCheckedAtMs: Date.now() }
            : x,
        ),
      );
    } catch (e) {
      // Ignore timeouts; polling will retry and may fail over.
      if (e instanceof RpcTimeoutError) return;
      setTxs((prev) =>
        prev.map((x) =>
          x.localTxId === localTxId
            ? { ...x, status: "error", lastReceipt: { error: e instanceof Error ? e.message : String(e) }, lastCheckedAtMs: Date.now() }
            : x,
        ),
      );
    }
  }

  return (
    <div className="wrap">
      <div className="header">
        <div className="brand">
          <CatalystLogo height={22} className="brandLogo" />
          <div className="brandText">
            <div className="title">Wallet</div>
            <div className="subtitle">
              Network: <span className="v">{CATALYST_TESTNET.networkId}</span> · chain_id{" "}
              <span className="v">{CATALYST_TESTNET.chainId.toString()}</span>
            </div>
          </div>
        </div>
        <div className="row">
          <input
            style={{ width: 340 }}
            value={rpcBaseUrl}
            onChange={(e) => setRpcBaseUrl(e.target.value)}
            placeholder='RPC URL (e.g. https://testnet-eu-rpc.catalystnet.org or "/rpc" in dev)'
          />
          {!locked ? (
            <button className="danger" onClick={lock}>
              Lock
            </button>
          ) : null}
        </div>
      </div>

      {locked ? (
        <div className="grid">
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <div style={{ fontWeight: 700 }}>Unlock</div>
                <div className="small">Uses your local encrypted vault.</div>
              </div>
            </div>
            <div className="spacer" />
            {hasVault ? (
              <>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  style={{ width: "100%" }}
                />
                <div className="spacer" />
                <button
                  onClick={() =>
                    unlock().catch((e) => setChainError(e instanceof Error ? e.message : String(e)))
                  }
                >
                  Unlock
                </button>
              </>
            ) : (
              <div className="small">No vault found yet. Create or restore one on the right.</div>
            )}
            {chainError ? (
              <div className="error">
                {chainError === "Failed to fetch" ? (
                  <>
                    Cannot reach RPC from the browser (likely CORS). In dev, set RPC URL to{" "}
                    <span className="v">/rpc</span>.
                  </>
                ) : (
                  chainError
                )}
              </div>
            ) : null}
          </div>

          <div className="card">
            <div style={{ fontWeight: 700 }}>Get started</div>
            <div className="small">Create a new mnemonic wallet, restore from mnemonic, or import a private key.</div>
            <div className="spacer" />

            {onboardingMode === "choose" ? (
              <div className="row">
                <button className="secondary" onClick={() => { setOnboardingMode("create"); setOnboardError(null); }}>
                  Create wallet
                </button>
                <button className="secondary" onClick={() => { setOnboardingMode("restore"); setOnboardError(null); }}>
                  Restore wallet
                </button>
                <button className="secondary" onClick={() => { setOnboardingMode("import"); setOnboardError(null); }}>
                  Import private key
                </button>
              </div>
            ) : null}

            {onboardingMode === "create" ? (
              <>
                <div className="spacer" />
                <div className="row">
                  <button
                    className="secondary"
                    onClick={() => {
                      resetCreateMnemonic(createWords);
                    }}
                  >
                    Regenerate
                  </button>
                  <button
                    className="secondary"
                    onClick={() => {
                      resetCreateMnemonic(createWords === 12 ? 24 : 12);
                    }}
                  >
                    {createWords === 12 ? "Use 24 words" : "Use 12 words"}
                  </button>
                </div>
                <div className="spacer" />
                <div className="small">Write these words down (in order). This is your backup.</div>
                <textarea value={createMnemonicText} readOnly />
                <div className="spacer" />
                <div className="small">Confirm by entering these words (case-insensitive).</div>
                <div className="row">
                  <input
                    value={createConfirmWords[0] ?? ""}
                    onChange={(e) => setCreateConfirmWords((w) => [e.target.value, w[1] ?? "", w[2] ?? ""])}
                    placeholder={`Word #${createConfirmIdxs[0] ?? "?"}`}
                    style={{ flex: 1, minWidth: 180 }}
                  />
                  <input
                    value={createConfirmWords[1] ?? ""}
                    onChange={(e) => setCreateConfirmWords((w) => [w[0] ?? "", e.target.value, w[2] ?? ""])}
                    placeholder={`Word #${createConfirmIdxs[1] ?? "?"}`}
                    style={{ flex: 1, minWidth: 180 }}
                  />
                  <input
                    value={createConfirmWords[2] ?? ""}
                    onChange={(e) => setCreateConfirmWords((w) => [w[0] ?? "", w[1] ?? "", e.target.value])}
                    placeholder={`Word #${createConfirmIdxs[2] ?? "?"}`}
                    style={{ flex: 1, minWidth: 180 }}
                  />
                </div>
                <div className="spacer" />
                <input
                  type="password"
                  value={onboardPassword}
                  onChange={(e) => setOnboardPassword(e.target.value)}
                  placeholder="Set a password to encrypt this device vault"
                  style={{ width: "100%" }}
                />
                <div className="spacer" />
                <div className="row">
                  <button onClick={() => completeOnboardingCreate()}>Create encrypted vault</button>
                  <button className="secondary" onClick={() => setOnboardingMode("choose")}>
                    Back
                  </button>
                </div>
              </>
            ) : null}

            {onboardingMode === "restore" ? (
              <>
                <div className="spacer" />
                <div className="small">Enter your mnemonic words to restore.</div>
                <textarea value={restoreMnemonic} onChange={(e) => setRestoreMnemonic(e.target.value)} placeholder="mnemonic words…" />
                <div className="spacer" />
                <input
                  value={restorePassphrase}
                  onChange={(e) => setRestorePassphrase(e.target.value)}
                  placeholder="Optional passphrase (advanced)"
                  style={{ width: "100%" }}
                />
                <div className="spacer" />
                <input
                  type="password"
                  value={onboardPassword}
                  onChange={(e) => setOnboardPassword(e.target.value)}
                  placeholder="Set a password to encrypt this device vault"
                  style={{ width: "100%" }}
                />
                <div className="spacer" />
                <div className="row">
                  <button onClick={() => completeOnboardingRestore()}>Restore encrypted vault</button>
                  <button className="secondary" onClick={() => setOnboardingMode("choose")}>
                    Back
                  </button>
                </div>
              </>
            ) : null}

            {onboardingMode === "import" ? (
              <>
                <div className="spacer" />
                <div className="small">Import a raw 32-byte private key (hex).</div>
                <input value={importPrivkeyHex} onChange={(e) => setImportPrivkeyHex(e.target.value)} style={{ width: "100%" }} />
                <div className="spacer" />
                <input
                  type="password"
                  value={onboardPassword}
                  onChange={(e) => setOnboardPassword(e.target.value)}
                  placeholder="Set a password to encrypt this device vault"
                  style={{ width: "100%" }}
                />
                <div className="spacer" />
                <div className="row">
                  <button onClick={() => completeOnboardingImport()}>Import encrypted vault</button>
                  <button className="secondary" onClick={() => setOnboardingMode("choose")}>
                    Back
                  </button>
                </div>
              </>
            ) : null}

            {onboardError ? <div className="error">{onboardError}</div> : null}
          </div>
        </div>
      ) : (
        <div className="grid">
          <div className="card">
            <div style={{ fontWeight: 700 }}>Account</div>
            <div className="spacer" />
            <div className="kv">
              <div className="k">Address</div>
              <div className="v">{addressHex}</div>
              <div className="k">Account</div>
              <div className="v">
                {walletData ? (
                  <select
                    value={selectedAccountId ?? getSelectedAccount(walletData).id}
                    onChange={(e) => switchAccount(e.target.value).catch((err) => setRefreshError(err instanceof Error ? err.message : String(err)))}
                  >
                    {walletData.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  "—"
                )}
              </div>
              <div className="k">Chain identity</div>
              <div className="v">
                {chainStatus}
              </div>
              <div className="k">Balance</div>
              <div className="v">{balance === null ? "—" : balance.toString(10)}</div>
              <div className="k">Nonce</div>
              <div className="v">{nonce === null ? "—" : nonce.toString(10)}</div>
              <div className="k">Next nonce</div>
              <div className="v">{nextNonceHint === null ? "—" : nextNonceHint.toString(10)}</div>
            </div>
            <div className="spacer" />
            <div className="row">
              <button className="secondary" onClick={() => refreshAccount()}>
                Refresh
              </button>
              <button className="secondary" onClick={() => verifyChain()}>
                Verify chain
              </button>
              {walletData?.kind === "mnemonic_v1" ? (
                <button className="secondary" onClick={() => addNewAccount().catch((err) => setRefreshError(err instanceof Error ? err.message : String(err)))}>
                  Add account
                </button>
              ) : null}
            </div>
            {refreshError ? <div className="error">{refreshError}</div> : null}
            {chainError ? <div className="error">{chainError}</div> : null}
          </div>

          <div className="card">
            <div style={{ fontWeight: 700 }}>Backup &amp; export</div>
            <div className="small">Re-enter your password to reveal sensitive material.</div>
            <div className="spacer" />
            <label className="small" style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input type="checkbox" checked={revealAck} onChange={(e) => setRevealAck(e.target.checked)} />
              I understand that anyone who sees this can take my funds.
            </label>
            <div className="spacer" />
            <input
              type="password"
              value={revealPassword}
              onChange={(e) => setRevealPassword(e.target.value)}
              placeholder="Password"
              style={{ width: "100%" }}
            />
            <div className="spacer" />
            <div className="row">
              {walletData?.kind === "mnemonic_v1" ? (
                <button className="secondary" disabled={revealBusy} onClick={() => revealSecret("mnemonic")}>
                  Show mnemonic
                </button>
              ) : null}
              <button className="secondary" disabled={revealBusy} onClick={() => revealSecret("private_key")}>
                Show private key
              </button>
              {revealedText ? (
                <button
                  className="secondary"
                  onClick={() => {
                    if (revealHideTimerRef.current) window.clearTimeout(revealHideTimerRef.current);
                    setRevealedText(null);
                    setRevealMode(null);
                    setRevealError(null);
                  }}
                >
                  Hide
                </button>
              ) : null}
            </div>
            {revealError ? <div className="error">{revealError}</div> : null}
            {revealedText ? (
              <>
                <div className="spacer" />
                <textarea value={revealedText} readOnly />
                <div className="spacer" />
                <div className="row">
                  <button className="secondary" onClick={() => copyToClipboard(revealedText)}>
                    Copy
                  </button>
                  <div className="small">
                    Showing: <span className="v">{revealMode ?? "secret"}</span>
                  </div>
                </div>
              </>
            ) : null}
          </div>

          <div className="card">
            <div style={{ fontWeight: 700 }}>Send transfer (v1)</div>
            <div className="small">NonConfidentialTransfer entries sum to 0; fees are set in core.fees.</div>
            <div className="spacer" />
            <input value={toHex} onChange={(e) => setToHex(e.target.value)} placeholder="To address (0x + 64 hex)" style={{ width: "100%" }} />
            <div className="spacer" />
            <input value={amountStr} onChange={(e) => setAmountStr(e.target.value)} placeholder="Amount (decimal)" style={{ width: "100%" }} />
            <div className="spacer" />
            <div className="row">
              <button
                className="secondary"
                disabled={sendBusy}
                onClick={() => estimateFee().catch((e) => setSendError(e instanceof Error ? e.message : String(e)))}
              >
                Estimate fee
              </button>
              <div className="small">fee: {fee === null ? "—" : fee.toString(10)}</div>
            </div>
            <div className="spacer" />
            <button
              disabled={sendBusy}
              onClick={() => send().catch((e) => setSendError(e instanceof Error ? e.message : String(e)))}
            >
              {sendBusy ? "Submitting…" : "Sign & submit"}
            </button>
            {sendError ? <div className="error">{sendError}</div> : null}
            {sendOk ? <div className="ok">{sendOk}</div> : null}
          </div>

          {faucetEnabled ? (
            <div className="card">
              <div style={{ fontWeight: 700 }}>Get testnet funds (dev-only)</div>
              <div className="small">
                Uses a deterministic shared faucet key on <span className="v">catalyst-testnet</span>. Do not ship this in production.
              </div>
              <div className="spacer" />
              <div className="kv">
                <div className="k">Faucet address</div>
                <div className="v">{faucetAddressHex ?? "—"}</div>
              </div>
              <div className="spacer" />
              <input
                value={faucetAmountStr}
                onChange={(e) => setFaucetAmountStr(e.target.value)}
                placeholder="Amount (decimal)"
                style={{ width: "100%" }}
              />
              <div className="spacer" />
              <div className="row">
                <button onClick={() => requestFaucetFunds()} disabled={faucetBusy || chainOk !== true}>
                  {faucetBusy ? "Requesting…" : "Request funds"}
                </button>
                {chainOk !== true ? (
                  <button className="secondary" onClick={() => verifyChain()}>
                    Verify chain
                  </button>
                ) : null}
              </div>
              {chainOk !== true ? <div className="error">{chainError ?? "Chain identity is not verified yet."}</div> : null}
              {faucetError ? <div className="error">{faucetError}</div> : null}
              {faucetOk ? <div className="ok">{faucetOk}</div> : null}
            </div>
          ) : null}

          <div className="card" style={{ gridColumn: "1 / -1" }}>
            <div style={{ fontWeight: 700 }}>Transactions</div>
            <div className="small">
              Receipt polling every ~2.5s. Note: <span className="v">pending</span> receipts are often{" "}
              <span className="v">RPC-node local</span> (another RPC/explorer may not show them until applied).
            </div>
            <div className="spacer" />
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="small">Recent on-chain activity (by address)</div>
              <div className="row">
                <button className="secondary" onClick={() => refreshHistory()} disabled={historyBusy}>
                  {historyBusy ? "Loading…" : "Refresh history"}
                </button>
                <button className="secondary" onClick={() => wipeLocalHistory()} disabled={!addressHex}>
                  Wipe history
                </button>
              </div>
            </div>
            {historyError ? <div className="error">{historyError}</div> : null}
            <div className="card" style={{ marginTop: 10, padding: "10px 14px" }}>
              {history.length > 0 ? (
                <div>
                  {history.slice(0, 10).map((h) => renderHistoryItem(h))}
                </div>
              ) : (
                <div className="small">
                  {historyBusy ? "Loading…" : "No recent activity found yet."}
                </div>
              )}
            </div>
            {txs.length === 0 ? (
              <div className="small">No transactions yet.</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {txs.map((t) => (
                  <div key={t.localTxId} className="kv" style={{ gridTemplateColumns: "160px 1fr" }}>
                    <div className="k">tx_id</div>
                    <div className="row">
                      <span className="v">{t.rpcTxId ?? t.localTxId}</span>
                      <button className="secondary miniBtn" onClick={() => copyToClipboard(t.rpcTxId ?? t.localTxId)}>
                        Copy
                      </button>
                      <button className="secondary miniBtn" onClick={() => openExplorerTx(t.rpcTxId ?? t.localTxId)}>
                        Explorer
                      </button>
                    </div>
                    <div className="k">status</div>
                    <div className="v">
                      {t.status ?? "—"}{" "}
                      <button className="secondary miniBtn" style={{ marginLeft: 8 }} onClick={() => checkTxNow(t.localTxId)}>
                        Check
                      </button>
                    </div>
                    <div className="k">receipt</div>
                    <div className="v">{t.lastReceipt ? JSON.stringify(t.lastReceipt) : "—"}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

