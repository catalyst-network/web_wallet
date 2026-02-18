import type { CatalystNetworkConfig } from "./network.js";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown[];
};

type JsonRpcResponse<T> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string; data?: unknown } };

export type CatalystSyncInfo = {
  chain_id: string;
  network_id: string;
  genesis_hash: string;
};

type RpcClientOptions = {
  /**
   * Default per-request timeout.
   * Used for all RPCs unless overridden per call.
   */
  timeoutMs?: number;
};

class RpcHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RpcHttpError";
  }
}

export class RpcTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcTimeoutError";
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

export type RpcTransactionRequest = {
  from: string;
  to: string;
  value: string;
  data: string | null;
  gas_limit: string | null;
  gas_price: string | null;
};

export type RpcTxReceipt = {
  status: "pending" | "selected" | "applied" | "dropped" | string;
  selected_cycle?: number | null;
  applied_cycle?: number | null;
  applied_success?: boolean | null;
  applied_error?: string | null;
};

export type RpcTransactionSummary = {
  hash: `0x${string}`;
  from: `0x${string}` | string;
  to: (`0x${string}` | string) | null;
  value: string;
};

export class CatalystRpcClient {
  private nextId = 1;
  private lastGoodIndex = 0;
  private readonly urls: string[];
  private readonly timeoutMs: number;

  constructor(rpcUrlOrUrls: string | string[], opts: RpcClientOptions = {}) {
    this.urls = (Array.isArray(rpcUrlOrUrls) ? rpcUrlOrUrls : [rpcUrlOrUrls])
      .map((u) => u.trim())
      .filter(Boolean);
    if (this.urls.length === 0) throw new Error("RPC URL(s) required");
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** Primary (preferred) RPC URL. */
  get rpcUrl(): string {
    return this.urls[0]!;
  }

  /** Ordered list of RPC URLs used for failover. */
  get rpcUrls(): readonly string[] {
    return this.urls;
  }

  private orderedIndexesForAttempt(): number[] {
    const n = this.urls.length;
    const start = Math.max(0, Math.min(n - 1, this.lastGoodIndex));
    const idxs: number[] = [];
    for (let i = start; i < n; i++) idxs.push(i);
    for (let i = 0; i < start; i++) idxs.push(i);
    return idxs;
  }

  private shouldFailover(err: unknown): boolean {
    if (err instanceof RpcTimeoutError) return true;
    if (err instanceof DOMException && err.name === "AbortError") return true; // timeout (fallback)
    if (err instanceof RpcHttpError) {
      // Retry on upstream/network style failures; don't retry client mistakes.
      return err.status >= 500 || err.status === 408 || err.status === 429;
    }
    // Fetch throws TypeError on network errors in browsers.
    if (err instanceof TypeError) return true;
    // Be conservative: don't failover on explicit RPC errors (method errors, signature invalid, etc).
    return false;
  }

  private async fetchRpc<T>(url: string, req: JsonRpcRequest, timeoutMs: number): Promise<T> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new RpcTimeoutError(`RPC timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
          signal: ac.signal,
        });
      } catch (e) {
        // Chromium sometimes reports timeouts as AbortError messages like:
        // "signal is aborted without reason"
        if (isAbortError(e)) throw new RpcTimeoutError(`RPC timeout after ${timeoutMs}ms`);
        throw e;
      }
      if (!res.ok) throw new RpcHttpError(`RPC HTTP ${res.status}`, res.status);
      const json = (await res.json()) as JsonRpcResponse<T>;
      if ("error" in json) throw new Error(`RPC ${json.error.code}: ${json.error.message}`);
      return json.result;
    } finally {
      clearTimeout(t);
    }
  }

  async call<T>(
    method: string,
    params?: unknown[],
    opts?: { timeoutMs?: number; allowFailover?: boolean },
  ): Promise<T> {
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params,
    };
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    const allowFailover = opts?.allowFailover ?? true;

    let lastErr: unknown = null;
    const idxs = allowFailover ? this.orderedIndexesForAttempt() : [this.lastGoodIndex];
    for (const idx of idxs) {
      const url = this.urls[idx]!;
      try {
        const out = await this.fetchRpc<T>(url, req, timeoutMs);
        this.lastGoodIndex = idx;
        return out;
      } catch (e) {
        lastErr = e;
        if (!allowFailover || !this.shouldFailover(e)) break;
        // try next endpoint
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async getSyncInfo(): Promise<CatalystSyncInfo> {
    return await this.call<CatalystSyncInfo>("catalyst_getSyncInfo");
  }

  async chainId(): Promise<string> {
    return await this.call<string>("catalyst_chainId");
  }
  async networkId(): Promise<string> {
    return await this.call<string>("catalyst_networkId");
  }
  async genesisHash(): Promise<string> {
    return await this.call<string>("catalyst_genesisHash");
  }

  async getBalance(addressHex32: string): Promise<bigint> {
    const s = await this.call<string>("catalyst_getBalance", [addressHex32]);
    return BigInt(s);
  }

  async getNonce(addressHex32: string): Promise<bigint> {
    const n = await this.call<number>("catalyst_getNonce", [addressHex32]);
    return BigInt(n);
  }

  async estimateFee(req: RpcTransactionRequest): Promise<bigint> {
    const s = await this.call<string>("catalyst_estimateFee", [req]);
    return BigInt(s);
  }

  async sendRawTransaction(wireHex: string): Promise<`0x${string}`> {
    // Allow longer timeout for broadcasts.
    const txid = await this.call<string>("catalyst_sendRawTransaction", [wireHex], {
      timeoutMs: Math.max(this.timeoutMs, 20_000),
    });
    return txid as `0x${string}`;
  }

  async getTransactionReceipt(txid: string): Promise<null | RpcTxReceipt> {
    return await this.call<null | RpcTxReceipt>("catalyst_getTransactionReceipt", [txid]);
  }

  async getTransactionsByAddress(args: {
    addressHex32: string;
    fromCycle?: number | null;
    limit: number;
  }): Promise<RpcTransactionSummary[]> {
    const fromCycle = args.fromCycle ?? null;
    return await this.call<RpcTransactionSummary[]>("catalyst_getTransactionsByAddress", [
      args.addressHex32,
      fromCycle,
      args.limit,
    ]);
  }
}

export async function assertChainIdentity(
  rpc: CatalystRpcClient,
  cfg: CatalystNetworkConfig,
): Promise<void> {
  // Prefer sync info (single round-trip), fall back if needed.
  let chainId: string | null = null;
  let networkId: string | null = null;
  let genesisHash: string | null = null;
  try {
    const si = await rpc.getSyncInfo();
    chainId = si.chain_id;
    networkId = si.network_id;
    genesisHash = si.genesis_hash;
  } catch {
    chainId = await rpc.chainId();
    networkId = await rpc.networkId();
    genesisHash = await rpc.genesisHash();
  }

  const normalize = (s: string) => s.toLowerCase();
  const chainHex = normalize(chainId);
  const chainNum = chainHex.startsWith("0x") ? BigInt(chainHex) : BigInt(chainHex);

  if (chainNum !== cfg.chainId) {
    throw new Error(`Chain ID mismatch: RPC=${chainId} expected=${cfg.chainId.toString()}`);
  }
  if (normalize(networkId) !== normalize(cfg.networkId)) {
    throw new Error(`Network ID mismatch: RPC=${networkId} expected=${cfg.networkId}`);
  }
  if (normalize(genesisHash) !== normalize(cfg.genesisHashHex)) {
    throw new Error(`Genesis hash mismatch: RPC=${genesisHash} expected=${cfg.genesisHashHex}`);
  }
}

