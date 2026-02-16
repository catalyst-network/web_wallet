import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CATALYST_TESTNET,
  CatalystRpcClient,
  CATALYST_TESTNET_DEV_FAUCET_PRIVKEY_HEX,
  assertChainIdentity,
  buildAndSignTransferTxV1,
  normalizeHex32,
  pubkeyFromPrivkeyHex,
} from "@catalyst/catalyst-sdk";
import { createVaultV1, openVaultV1, type VaultRecordV1, validatePrivateKeyHex } from "@catalyst/wallet-core";

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

function randomPrivkeyHex(): `0x${string}` {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s as `0x${string}`;
}

export function App() {
  // Default to same-origin dev proxy to avoid browser CORS issues.
  const [rpcUrl, setRpcUrl] = useState(() => localStorage.getItem(LS_RPC_URL) ?? "/rpc");
  const rpc = useMemo(() => new CatalystRpcClient(rpcUrl), [rpcUrl]);

  const [vault, setVault] = useState<VaultRecordV1 | null>(() => readVault());
  const [locked, setLocked] = useState(true);

  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [importPrivkey, setImportPrivkey] = useState<`0x${string}` | string>("");
  const [generatedPrivkey, setGeneratedPrivkey] = useState<`0x${string}`>(() => randomPrivkeyHex());

  const [privkeyHex, setPrivkeyHex] = useState<`0x${string}` | null>(null);
  const [addressHex, setAddressHex] = useState<`0x${string}` | null>(null);

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

  const [faucetAmountStr, setFaucetAmountStr] = useState("1000");
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const [faucetOk, setFaucetOk] = useState<string | null>(null);
  const [faucetNextNonceHint, setFaucetNextNonceHint] = useState<bigint | null>(null);

  const pollTimer = useRef<number | null>(null);
  const nextNonceByAddrRef = useRef<Map<string, bigint>>(new Map());
  const nonceLocksRef = useRef<Map<string, Promise<void>>>(new Map());

  useEffect(() => {
    localStorage.setItem(LS_RPC_URL, rpcUrl);
  }, [rpcUrl]);

  useEffect(() => {
    // reset chain state on rpc changes
    setChainOk(null);
    setChainError(null);
  }, [rpcUrl]);

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
    if (!privkeyHex) return;
    setAddressHex(pubkeyFromPrivkeyHex(privkeyHex));
  }, [privkeyHex]);

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
    const json = JSON.parse(bytesToUtf8(plaintext)) as { privateKeyHex: string };
    const pk = validatePrivateKeyHex(json.privateKeyHex);
    setPrivkeyHex(pk);
    setLocked(false);
    setPassword("");
    setVault(v);
  }

  function lock() {
    setLocked(true);
    setPrivkeyHex(null);
    setAddressHex(null);
    setBalance(null);
    setNonce(null);
    setNextNonceHint(null);
    setFee(null);
    setTxs([]);
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
    if (chainOk !== true) {
      setSendError("Refusing to sign: chain identity is not verified.");
      return;
    }
    if (sendBusy) return;
    setSendError(null);
    setSendOk(null);
    setSendBusy(true);

    try {
      const to = normalizeHex32(toHex.trim());
      const amount = BigInt(amountStr.trim());
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

  const faucetEnabled = import.meta.env.DEV && CATALYST_TESTNET.networkId === "catalyst-testnet";
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
  }, [faucetAddressHex, rpcUrl]);

  async function requestFaucetFunds() {
    if (!faucetEnabled) return;
    if (!addressHex) return;
    if (chainOk !== true) {
      setFaucetError("Chain identity is not verified.");
      return;
    }
    if (!faucetAddressHex) return;

    setFaucetBusy(true);
    setFaucetError(null);
    setFaucetOk(null);

    try {
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
        <div>
          <div className="title">Catalyst Wallet</div>
          <div className="subtitle">
            Network: <span className="v">{CATALYST_TESTNET.networkId}</span> · chain_id{" "}
            <span className="v">{CATALYST_TESTNET.chainId.toString()}</span>
          </div>
        </div>
        <div className="row">
          <input
            style={{ width: 340 }}
            value={rpcUrl}
            onChange={(e) => setRpcUrl(e.target.value)}
            placeholder='RPC URL (try "/rpc")'
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
                <button onClick={() => unlock().catch((e) => setChainError(e instanceof Error ? e.message : String(e)))}>
                  Unlock
                </button>
              </>
            ) : (
              <div className="small">No vault found yet. Create one on the right.</div>
            )}
            {chainError ? <div className="error">{chainError}</div> : null}
          </div>

          <div className="card">
            <div style={{ fontWeight: 700 }}>Create vault (MVP)</div>
            <div className="small">Stores a single 32-byte private key encrypted with scrypt + XChaCha20-Poly1305.</div>
            <div className="spacer" />
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password"
              style={{ width: "100%" }}
            />
            <div className="spacer" />
            <div className="small">Option A: import private key hex (32 bytes, 0x-prefixed).</div>
            <input
              value={importPrivkey}
              onChange={(e) => setImportPrivkey(e.target.value)}
              placeholder="0x… (64 hex chars)"
              style={{ width: "100%" }}
            />
            <div className="spacer" />
            <div className="small">Option B: generate a random private key (save it somewhere safe).</div>
            <textarea value={generatedPrivkey} readOnly />
            <div className="row">
              <button className="secondary" onClick={() => setGeneratedPrivkey(randomPrivkeyHex())}>
                Regenerate
              </button>
              <button
                onClick={() => {
                  try {
                    const pk = importPrivkey ? validatePrivateKeyHex(importPrivkey) : validatePrivateKeyHex(generatedPrivkey);
                    const addr = pubkeyFromPrivkeyHex(pk);
                    const record = createVaultV1({
                      password: newPassword,
                      plaintext: utf8ToBytes(JSON.stringify({ privateKeyHex: pk, addressHex: addr })),
                    });
                    writeVault(record);
                    setVault(record);
                    setChainError(null);
                    setNewPassword("");
                    setImportPrivkey("");
                  } catch (e) {
                    setChainError(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                Create vault
              </button>
            </div>
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
            </div>
            {refreshError ? <div className="error">{refreshError}</div> : null}
            {chainError ? <div className="error">{chainError}</div> : null}
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
            {txs.length === 0 ? (
              <div className="small">No transactions yet.</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {txs.map((t) => (
                  <div key={t.localTxId} className="kv" style={{ gridTemplateColumns: "160px 1fr" }}>
                    <div className="k">tx_id</div>
                    <div className="v">{t.rpcTxId ?? t.localTxId}</div>
                    <div className="k">status</div>
                    <div className="v">
                      {t.status ?? "—"}{" "}
                      <button className="secondary" style={{ padding: "6px 10px", marginLeft: 8 }} onClick={() => checkTxNow(t.localTxId)}>
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

