import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CATALYST_TESTNET,
  CatalystRpcClient,
  assertChainIdentity,
  RpcTimeoutError,
  buildAndSignTransferTxV1,
  normalizeHex32,
} from "@catalyst/catalyst-sdk";
import QRCode from "qrcode";
import { CatalystLogo } from "../ui/CatalystLogo.js";
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

type OnboardingMode = "choose" | "create" | "restore" | "import";

type UiTx = {
  localTxId: `0x${string}`;
  rpcTxId?: `0x${string}`;
  status?: string;
  lastReceipt?: unknown;
  lastCheckedAtMs?: number;
  createdAtMs: number;
};

const STORAGE_VAULT_KEY = "catalyst_wallet_vault_v1";
const STORAGE_RPC_URL_KEY = "catalyst_wallet_rpc_url";
const STORAGE_TXS_PREFIX = "catalyst_wallet_txs_v1";

const EXPLORER_BASE_URL = "https://explorer.catalystnet.org";
function explorerTxUrl(txid: string): string {
  return `${EXPLORER_BASE_URL}/tx/${txid}`;
}
function explorerBlockUrl(cycle: number): string {
  return `${EXPLORER_BASE_URL}/block/${cycle}`;
}

function bytesToUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}
function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function nowMs(): bigint {
  return BigInt(Date.now());
}
function nowSecondsU32(): number {
  const s = Math.floor(Date.now() / 1000);
  return Math.max(0, Math.min(0xffffffff, s));
}
function shortHex(hex: string, left = 10, right = 8): string {
  if (!hex || hex.length <= left + right + 1) return hex;
  return `${hex.slice(0, left)}…${hex.slice(-right)}`;
}

async function copyText(s: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(s);
  } catch {
    // ignore (clipboard may be blocked); UX still offers manual selection
  }
}

async function storageGet<T>(key: string): Promise<T | null> {
  const r = await chrome.storage.local.get(key);
  return (r[key] as T | undefined) ?? null;
}
async function storageSet(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}
async function storageRemove(key: string): Promise<void> {
  await chrome.storage.local.remove(key);
}

export function PopupApp() {
  const isFullPage = typeof window !== "undefined" && window.location.pathname.endsWith("full.html");
  const [vault, setVault] = useState<VaultRecordV1 | null>(null);
  const [locked, setLocked] = useState(true);
  const [sessionPassword, setSessionPassword] = useState<string | null>(null);
  const [walletData, setWalletData] = useState<WalletDataV2 | null>(null);

  const [rpcBaseUrl, setRpcBaseUrl] = useState<string>(CATALYST_TESTNET.rpcUrls[0]!);
  const rpcUrls = useMemo(() => {
    const base = rpcBaseUrl.trim();
    if (!base) return [...CATALYST_TESTNET.rpcUrls];
    if (base.startsWith("/")) return [base];
    return [base, ...CATALYST_TESTNET.rpcUrls.filter((u) => u !== base)];
  }, [rpcBaseUrl]);
  const rpc = useMemo(() => new CatalystRpcClient(rpcUrls), [rpcUrls.join("|")]);

  // Onboarding
  const [onboardingMode, setOnboardingMode] = useState<OnboardingMode>("choose");
  const [onboardPassword, setOnboardPassword] = useState("");
  const [onboardError, setOnboardError] = useState<string | null>(null);

  const [createWords, setCreateWords] = useState<12 | 24>(12);
  const [createMnemonicText, setCreateMnemonicText] = useState<string>(() => createMnemonic(128));
  const [createConfirmIdxs, setCreateConfirmIdxs] = useState<number[]>(() => [1, 6, 12]);
  const [createConfirmWords, setCreateConfirmWords] = useState<string[]>(() => ["", "", ""]);

  const [restoreMnemonic, setRestoreMnemonic] = useState("");
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [importPrivkeyHex, setImportPrivkeyHex] = useState("");

  // Account/session
  const [password, setPassword] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [addressHex, setAddressHex] = useState<`0x${string}` | null>(null);
  const [privkeyHex, setPrivkeyHex] = useState<`0x${string}` | null>(null);

  // Chain + account state
  const [chainOk, setChainOk] = useState<boolean | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [nonce, setNonce] = useState<bigint | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Receive QR
  const [receiveQrDataUrl, setReceiveQrDataUrl] = useState<string | null>(null);
  const [receiveQrError, setReceiveQrError] = useState<string | null>(null);

  // Sending
  const [toHex, setToHex] = useState("");
  const [amountStr, setAmountStr] = useState("1");
  const [fee, setFee] = useState<bigint | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendOk, setSendOk] = useState<string | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const [txs, setTxs] = useState<UiTx[]>([]);

  // Nonce allocator (same approach as web)
  const nextNonceByAddrRef = useRef<Map<string, bigint>>(new Map());
  const nonceLocksRef = useRef<Map<string, Promise<void>>>(new Map());
  const pollTimer = useRef<number | null>(null);

  const verifyChain = useCallback(async () => {
    setChainOk(null);
    setChainError(null);
    try {
      await assertChainIdentity(rpc, CATALYST_TESTNET);
      setChainOk(true);
      setChainError(null);
    } catch (e) {
      setChainOk(false);
      setChainError(e instanceof Error ? e.message : String(e));
    }
  }, [rpc]);

  useEffect(() => {
    // load persisted vault + rpc url
    (async () => {
      const v = await storageGet<VaultRecordV1>(STORAGE_VAULT_KEY);
      setVault(v);
      const url = await storageGet<string>(STORAGE_RPC_URL_KEY);
      if (url) setRpcBaseUrl(url);
    })().catch(() => {});
  }, []);

  useEffect(() => {
    storageSet(STORAGE_RPC_URL_KEY, rpcBaseUrl).catch(() => {});
  }, [rpcBaseUrl]);

  useEffect(() => {
    verifyChain().catch(() => {});
  }, [verifyChain]);

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

  const txsStorageKey = useMemo(() => {
    if (!addressHex) return null;
    return `${STORAGE_TXS_PREFIX}:${CATALYST_TESTNET.networkId}:${addressHex.toLowerCase()}`;
  }, [addressHex]);

  useEffect(() => {
    if (!addressHex || !txsStorageKey) return;
    (async () => {
      const stx = await storageGet<UiTx[]>(txsStorageKey);
      if (Array.isArray(stx)) setTxs(stx);
    })().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressHex]);

  useEffect(() => {
    if (!txsStorageKey) return;
    storageSet(txsStorageKey, txs.slice(0, 50)).catch(() => {});
  }, [txs, txsStorageKey]);

  async function wipeLocalHistory() {
    if (!txsStorageKey) return;
    await storageRemove(txsStorageKey);
    setTxs([]);
  }

  function openExplorerTx(txid: string) {
    chrome.tabs.create({ url: explorerTxUrl(txid) });
  }
  function openExplorerBlock(cycle: number) {
    chrome.tabs.create({ url: explorerBlockUrl(cycle) });
  }

  useEffect(() => {
    if (!addressHex) {
      setReceiveQrDataUrl(null);
      setReceiveQrError(null);
      return;
    }
    setReceiveQrError(null);
    QRCode.toDataURL(addressHex, { margin: 1, width: 320, errorCorrectionLevel: "M" })
      .then((url) => setReceiveQrDataUrl(url))
      .catch((e) => setReceiveQrError(e instanceof Error ? e.message : String(e)));
  }, [addressHex]);

  async function persistWallet(updated: WalletDataV2) {
    if (!sessionPassword) throw new Error("Locked");
    const record = createVaultV1({ password: sessionPassword, plaintext: utf8ToBytes(JSON.stringify(updated)) });
    await storageSet(STORAGE_VAULT_KEY, record);
    setVault(record);
    setWalletData(updated);
  }

  function pickConfirmIdxs(count: 12 | 24): number[] {
    const set = new Set<number>();
    while (set.size < 3) set.add(1 + Math.floor(Math.random() * count));
    return Array.from(set).sort((a, b) => a - b);
  }
  function resetCreateMnemonic(nextWords: 12 | 24) {
    setCreateWords(nextWords);
    setCreateMnemonicText(createMnemonic(nextWords === 12 ? 128 : 256));
    setCreateConfirmIdxs(pickConfirmIdxs(nextWords));
    setCreateConfirmWords(["", "", ""]);
  }

  async function unlock() {
    setRefreshError(null);
    setSendError(null);
    setSendOk(null);
    if (!vault) throw new Error("No vault");
    const plaintext = openVaultV1({ password, record: vault });
    const json = JSON.parse(bytesToUtf8(plaintext)) as unknown;
    const wd = parseWalletDataAny(json);
    setWalletData(wd);
    setLocked(false);
    setSessionPassword(password);
    setPassword("");
  }

  function lock() {
    setLocked(true);
    setWalletData(null);
    setSessionPassword(null);
    setSelectedAccountId(null);
    setAddressHex(null);
    setPrivkeyHex(null);
    setBalance(null);
    setNonce(null);
    setFee(null);
    setTxs([]);
  }

  async function refreshAccount() {
    if (!addressHex) return;
    setRefreshError(null);
    try {
      const [b, n] = await Promise.all([rpc.getBalance(addressHex), rpc.getNonce(addressHex)]);
      setBalance(b);
      setNonce(n);
      // floor next nonce
      const floor = n + 1n;
      const cur = nextNonceByAddrRef.current.get(addressHex);
      if (cur === undefined || cur < floor) nextNonceByAddrRef.current.set(addressHex, floor);
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : String(e));
    }
  }

  async function allocateNonce(senderHex32: string): Promise<bigint> {
    const prev = nonceLocksRef.current.get(senderHex32) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    nonceLocksRef.current.set(senderHex32, prev.then(() => next));
    await prev;
    try {
      let n = nextNonceByAddrRef.current.get(senderHex32);
      if (n === undefined) {
        const committed = await rpc.getNonce(senderHex32);
        n = committed + 1n;
      }
      nextNonceByAddrRef.current.set(senderHex32, n + 1n);
      return n;
    } finally {
      release();
    }
  }

  async function estimateFee() {
    if (!addressHex) return;
    setSendError(null);
    setSendOk(null);
    const to = normalizeHex32(toHex.trim());
    const amount = BigInt(amountStr.trim());
    if (amount <= 0n) throw new Error("Amount must be > 0");
    const f = await rpc.estimateFee({ from: addressHex, to, value: amount.toString(10), data: null, gas_limit: null, gas_price: null });
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
      await assertChainIdentity(rpc, CATALYST_TESTNET);
      setChainOk(true);
      setChainError(null);

      const to = normalizeHex32(toHex.trim());
      const amount = BigInt(amountStr.trim());
      if (amount <= 0n) throw new Error("Amount must be > 0");
      const fees =
        fee ??
        (await rpc.estimateFee({ from: addressHex, to, value: amount.toString(10), data: null, gas_limit: null, gas_price: null }));
      const bal = balance ?? (await rpc.getBalance(addressHex));
      const required = to === addressHex ? fees : amount + fees;
      if (bal < required) throw new Error(`Insufficient balance: have=${bal} need=${required} (includes fees)`);

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
      setTxs((prev) => [{ localTxId, createdAtMs: Date.now(), status: "pending" }, ...prev]);
      const rpcTxId = await rpc.sendRawTransaction(built.wireHex);
      setTxs((prev) => prev.map((t) => (t.localTxId === localTxId ? { ...t, rpcTxId, status: "pending" } : t)));
      setSendOk(`Submitted: ${rpcTxId}`);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSendBusy(false);
    }
  }

  async function switchAccount(accountId: string) {
    if (!walletData) return;
    const updated = selectAccount(walletData, accountId);
    await persistWallet(updated);
    const acct = getSelectedAccount(updated);
    setSelectedAccountId(acct.id);
    setAddressHex(acct.addressHex);
    setPrivkeyHex(getPrivateKeyHexForAccount(updated, acct.id));
    refreshAccount().catch(() => {});
  }

  async function addNewAccount() {
    if (!walletData) return;
    const updated = addAccount(walletData);
    await persistWallet(updated);
    const acct = getSelectedAccount(updated);
    setSelectedAccountId(acct.id);
    setAddressHex(acct.addressHex);
    setPrivkeyHex(getPrivateKeyHexForAccount(updated, acct.id));
    refreshAccount().catch(() => {});
  }

  async function completeOnboardingCreate() {
    setOnboardError(null);
    try {
      if (!onboardPassword) throw new Error("Password is required");
      if (!isValidMnemonic(createMnemonicText.trim())) throw new Error("Mnemonic is invalid");
      const words = createMnemonicText.trim().split(/\s+/).map((w) => w.toLowerCase());
      const entered = createConfirmWords.map((w) => w.trim().toLowerCase());
      for (let i = 0; i < 3; i++) {
        const idx1 = createConfirmIdxs[i]!;
        if (entered[i] !== words[idx1 - 1]) throw new Error(`Confirmation failed for word #${idx1}`);
      }
      const wd = createMnemonicWalletV2({ mnemonic: createMnemonicText.trim(), passphrase: "", initialAccounts: 1 });
      const record = createVaultV1({ password: onboardPassword, plaintext: utf8ToBytes(JSON.stringify(wd)) });
      await storageSet(STORAGE_VAULT_KEY, record);
      setVault(record);
      setOnboardPassword("");
      setOnboardingMode("choose");
    } catch (e) {
      setOnboardError(e instanceof Error ? e.message : String(e));
    }
  }

  async function completeOnboardingRestore() {
    setOnboardError(null);
    try {
      if (!onboardPassword) throw new Error("Password is required");
      if (!isValidMnemonic(restoreMnemonic.trim())) throw new Error("Mnemonic is invalid");
      const wd = createMnemonicWalletV2({ mnemonic: restoreMnemonic.trim(), passphrase: restorePassphrase, initialAccounts: 1 });
      const record = createVaultV1({ password: onboardPassword, plaintext: utf8ToBytes(JSON.stringify(wd)) });
      await storageSet(STORAGE_VAULT_KEY, record);
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
      await storageSet(STORAGE_VAULT_KEY, record);
      setVault(record);
      setOnboardPassword("");
      setOnboardingMode("choose");
    } catch (e) {
      setOnboardError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    if (!locked && addressHex) refreshAccount().catch(() => {});
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
          setTxs((prev) =>
            prev.map((x) =>
              x.localTxId === t.localTxId
                ? { ...x, status: r?.status ?? "not_found", lastReceipt: r, lastCheckedAtMs: Date.now() }
                : x,
            ),
          );
          if (r?.status === "applied") refreshAccount().catch(() => {});
        } catch (e) {
          // Ignore timeouts; polling will retry and may fail over.
          if (e instanceof RpcTimeoutError) return;
        }
      }
    }, 2500);
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    };
  }, [locked, rpc, txs]);

  const chainStatus = chainOk === null ? "checking…" : chainOk ? "verified" : chainError ? "error" : "mismatch";

  return (
    <div className={`wrap${isFullPage ? " fullPage" : ""}`}>
      <div className="header">
        <div className="brand">
          <CatalystLogo height={20} className="brandLogo" />
          <div className="brandText">
            <div className="title">Wallet</div>
            <div className="subtitle">
              Extension · <span className="v">{CATALYST_TESTNET.networkId}</span>
            </div>
          </div>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          {!isFullPage ? (
            <button className="secondary" onClick={() => chrome.runtime.openOptionsPage()}>
              Open
            </button>
          ) : null}
          <button className="danger" onClick={lock} disabled={locked}>
            Lock
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="small">RPC URL</div>
          <input
            value={rpcBaseUrl}
            onChange={(e) => setRpcBaseUrl(e.target.value)}
            style={{ width: 260 }}
            placeholder={CATALYST_TESTNET.rpcUrls[0]}
          />
        </div>
      </div>

      <div className="spacer" />

      {locked ? (
        <div className="grid">
          <div className="card">
            <div style={{ fontWeight: 700 }}>Unlock</div>
            <div className="small">Vault stored in chrome.storage.local.</div>
            <div className="spacer" />
            {vault ? (
              <>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" style={{ width: "100%" }} />
                <div className="spacer" />
                <button onClick={() => unlock().catch((e) => setOnboardError(e instanceof Error ? e.message : String(e)))}>Unlock</button>
              </>
            ) : (
              <div className="small">No vault yet. Create or restore one.</div>
            )}
          </div>

          <div className="card">
            <div style={{ fontWeight: 700 }}>Get started</div>
            <div className="small">Create, restore, or import.</div>
            <div className="spacer" />
            {onboardingMode === "choose" ? (
              <div className="row">
                <button className="secondary" onClick={() => { setOnboardingMode("create"); setOnboardError(null); }}>Create</button>
                <button className="secondary" onClick={() => { setOnboardingMode("restore"); setOnboardError(null); }}>Restore</button>
                <button className="secondary" onClick={() => { setOnboardingMode("import"); setOnboardError(null); }}>Import</button>
              </div>
            ) : null}

            {onboardingMode === "create" ? (
              <>
                <div className="spacer" />
                <div className="row">
                  <button className="secondary" onClick={() => resetCreateMnemonic(createWords)}>Regenerate</button>
                  <button className="secondary" onClick={() => resetCreateMnemonic(createWords === 12 ? 24 : 12)}>
                    {createWords === 12 ? "Use 24 words" : "Use 12 words"}
                  </button>
                </div>
                <div className="spacer" />
                <textarea value={createMnemonicText} readOnly />
                <div className="spacer" />
                <div className="row">
                  <input value={createConfirmWords[0] ?? ""} onChange={(e) => setCreateConfirmWords((w) => [e.target.value, w[1] ?? "", w[2] ?? ""])} placeholder={`Word #${createConfirmIdxs[0]}`} style={{ flex: 1 }} />
                  <input value={createConfirmWords[1] ?? ""} onChange={(e) => setCreateConfirmWords((w) => [w[0] ?? "", e.target.value, w[2] ?? ""])} placeholder={`Word #${createConfirmIdxs[1]}`} style={{ flex: 1 }} />
                  <input value={createConfirmWords[2] ?? ""} onChange={(e) => setCreateConfirmWords((w) => [w[0] ?? "", w[1] ?? "", e.target.value])} placeholder={`Word #${createConfirmIdxs[2]}`} style={{ flex: 1 }} />
                </div>
                <div className="spacer" />
                <input type="password" value={onboardPassword} onChange={(e) => setOnboardPassword(e.target.value)} placeholder="Set vault password" style={{ width: "100%" }} />
                <div className="spacer" />
                <div className="row">
                  <button onClick={() => completeOnboardingCreate()}>Create vault</button>
                  <button className="secondary" onClick={() => setOnboardingMode("choose")}>Back</button>
                </div>
              </>
            ) : null}

            {onboardingMode === "restore" ? (
              <>
                <div className="spacer" />
                <textarea value={restoreMnemonic} onChange={(e) => setRestoreMnemonic(e.target.value)} placeholder="mnemonic words…" />
                <div className="spacer" />
                <input value={restorePassphrase} onChange={(e) => setRestorePassphrase(e.target.value)} placeholder="Optional passphrase" style={{ width: "100%" }} />
                <div className="spacer" />
                <input type="password" value={onboardPassword} onChange={(e) => setOnboardPassword(e.target.value)} placeholder="Set vault password" style={{ width: "100%" }} />
                <div className="spacer" />
                <div className="row">
                  <button onClick={() => completeOnboardingRestore()}>Restore vault</button>
                  <button className="secondary" onClick={() => setOnboardingMode("choose")}>Back</button>
                </div>
              </>
            ) : null}

            {onboardingMode === "import" ? (
              <>
                <div className="spacer" />
                <input value={importPrivkeyHex} onChange={(e) => setImportPrivkeyHex(e.target.value)} placeholder="0x… (32 bytes hex)" style={{ width: "100%" }} />
                <div className="spacer" />
                <input type="password" value={onboardPassword} onChange={(e) => setOnboardPassword(e.target.value)} placeholder="Set vault password" style={{ width: "100%" }} />
                <div className="spacer" />
                <div className="row">
                  <button onClick={() => completeOnboardingImport()}>Import vault</button>
                  <button className="secondary" onClick={() => setOnboardingMode("choose")}>Back</button>
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
              <div className="k">Chain</div>
              <div className="v">{chainStatus}</div>
              <div className="k">Balance</div>
              <div className="v">{balance?.toString(10) ?? "—"}</div>
              <div className="k">Nonce</div>
              <div className="v">{nonce?.toString(10) ?? "—"}</div>
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
                <button className="secondary" onClick={() => addNewAccount().catch(() => {})}>
                  Add account
                </button>
              ) : null}
            </div>
            <div className="spacer" />
            {walletData ? (
              <select
                value={selectedAccountId ?? getSelectedAccount(walletData).id}
                onChange={(e) => switchAccount(e.target.value).catch(() => {})}
              >
                {walletData.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            ) : null}
            {refreshError ? <div className="error">{refreshError}</div> : null}
            {chainError ? <div className="error">{chainError}</div> : null}
          </div>

          <div className="card">
            <div style={{ fontWeight: 700 }}>Receive</div>
            <div className="small">Scan to pay this address.</div>
            <div className="spacer" />
            {addressHex ? (
              <>
                <div className="qrWrap">
                  {receiveQrDataUrl ? (
                    <img className="qrImg" src={receiveQrDataUrl} alt="Receive address QR code" />
                  ) : (
                    <div className="small">Generating QR…</div>
                  )}
                </div>
                <div className="spacer" />
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div className="v" style={{ maxWidth: 520 }}>
                    {shortHex(addressHex, 18, 12)}
                  </div>
                  <button className="secondary" onClick={() => copyText(addressHex)}>
                    Copy
                  </button>
                </div>
                {receiveQrError ? <div className="error">{receiveQrError}</div> : null}
              </>
            ) : (
              <div className="small">Unlock to view your receive QR.</div>
            )}
          </div>

          <div className="card">
            <div style={{ fontWeight: 700 }}>Send</div>
            <div className="spacer" />
            <input value={toHex} onChange={(e) => setToHex(e.target.value)} placeholder="To (0x + 64 hex)" style={{ width: "100%" }} />
            <div className="spacer" />
            <input value={amountStr} onChange={(e) => setAmountStr(e.target.value)} placeholder="Amount" style={{ width: "100%" }} />
            <div className="spacer" />
            <div className="row">
              <button className="secondary" disabled={sendBusy} onClick={() => estimateFee().catch((e) => setSendError(String(e)))}>
                Fee
              </button>
              <div className="small">fee: {fee?.toString(10) ?? "—"}</div>
            </div>
            <div className="spacer" />
            <button disabled={sendBusy} onClick={() => send().catch((e) => setSendError(String(e)))}>
              {sendBusy ? "Submitting…" : "Sign & submit"}
            </button>
            {sendError ? <div className="error">{sendError}</div> : null}
            {sendOk ? <div className="ok">{sendOk}</div> : null}
          </div>

          <div className="card" style={{ gridColumn: "1 / -1" }}>
            <div style={{ fontWeight: 700 }}>Transactions</div>
            <div className="small">Local receipt polling.</div>
            <div className="spacer" />
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="secondary" onClick={() => wipeLocalHistory().catch(() => {})} disabled={!addressHex}>
                Wipe history
              </button>
            </div>
            <div className="spacer" />
            {txs.length === 0 ? (
              <div className="small">No transactions yet.</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {txs.map((t) => (
                  <div key={t.localTxId} className="kv" style={{ gridTemplateColumns: "110px 1fr" }}>
                    <div className="k">tx</div>
                    <div className="row">
                      <span className="v">{shortHex(t.rpcTxId ?? t.localTxId, 14, 10)}</span>
                      <button className="secondary miniBtn" onClick={() => copyText(t.rpcTxId ?? t.localTxId)}>
                        Copy
                      </button>
                      <button className="secondary miniBtn" onClick={() => openExplorerTx(t.rpcTxId ?? t.localTxId)}>
                        Explorer
                      </button>
                    </div>
                    <div className="k">status</div>
                    <div className="v">{t.status ?? "—"}</div>
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

